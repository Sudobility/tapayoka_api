import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  vendorInstallations,
  vendorOfferings,
  vendorModels,
  vendorInstallationSlots,
  orders,
} from "../../db/schema.ts";
import { verifySignature } from "../../services/crypto.ts";
import { deviceVerifySchema } from "../../schemas/index.ts";
import {
  successResponse,
  errorResponse,
  type BuyerVerifyResponse,
  type PricingTier,
  type DailySchedule,
  type DayOfWeek,
  type VendorModelSlot,
  type VendorModelPricing,
  type VendorModelSlotPricing,
  type VendorModelAction,
  type VendorModelInterruption,
  type VendorModelPayment,
} from "@sudobility/tapayoka_types";

const buyerDevices = new Hono();

const ACTIVE_ORDER_STATUSES = [
  "CREATED",
  "PAID",
  "AUTHORIZED",
  "RUNNING",
] as const;

const MAX_DEVICE_PROOF_AGE_MS = 2 * 60 * 1000;
const seenDeviceProofs = new Map<string, number>();

interface DeviceProofPayload {
  walletAddress?: unknown;
  timestamp?: unknown;
  nonce?: unknown;
  signing_timestamp?: unknown;
}

function cleanupSeenDeviceProofs(now = Date.now()): void {
  for (const [key, expiresAt] of seenDeviceProofs) {
    if (expiresAt <= now) seenDeviceProofs.delete(key);
  }
}

function validateDeviceProofPayload(
  signedPayload: string,
  deviceWalletAddress: string
): { ok: true; nonceKey: string } | { ok: false; error: string } {
  let payload: DeviceProofPayload;
  try {
    payload = JSON.parse(signedPayload) as DeviceProofPayload;
  } catch {
    return { ok: false, error: "Invalid signed payload" };
  }

  if (
    typeof payload.walletAddress !== "string" ||
    payload.walletAddress.toLowerCase() !== deviceWalletAddress.toLowerCase()
  ) {
    return { ok: false, error: "Signed payload wallet mismatch" };
  }

  if (typeof payload.nonce !== "string" || payload.nonce.length === 0) {
    return { ok: false, error: "Signed payload missing nonce" };
  }

  const now = Date.now();
  let signedAt: number | null = null;
  if (typeof payload.signing_timestamp === "string") {
    signedAt = new Date(payload.signing_timestamp).getTime();
  } else if (typeof payload.timestamp === "number") {
    signedAt = payload.timestamp * 1000;
  }

  if (signedAt === null || Number.isNaN(signedAt)) {
    return { ok: false, error: "Signed payload missing timestamp" };
  }
  if (Math.abs(now - signedAt) > MAX_DEVICE_PROOF_AGE_MS) {
    return { ok: false, error: "Signed payload expired" };
  }

  cleanupSeenDeviceProofs(now);
  const nonceKey = `${deviceWalletAddress.toLowerCase()}:${payload.nonce}`;
  if (seenDeviceProofs.has(nonceKey)) {
    return { ok: false, error: "Signed payload replayed" };
  }

  return { ok: true, nonceKey };
}

/**
 * Evaluate operating hours from schedule in given timezone.
 * Returns operating status and the current period boundaries in UTC.
 */
function evaluateOperating(
  schedule: DailySchedule[] | null,
  tz: string
): {
  operating: boolean;
  operatingPeriod: { start: string; end: string } | null;
} {
  if (!schedule || schedule.length === 0) {
    return { operating: true, operatingPeriod: null };
  }

  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const weekday = parts.find(p => p.type === "weekday")?.value as
    DayOfWeek | undefined;
  const hour = parts.find(p => p.type === "hour")?.value ?? "00";
  const minute = parts.find(p => p.type === "minute")?.value ?? "00";
  const currentTime = `${hour}:${minute}`;

  if (!weekday) {
    return { operating: true, operatingPeriod: null };
  }

  const matchedEntry = schedule.find(
    entry =>
      entry.dayOfWeek === weekday &&
      currentTime >= entry.startTime &&
      currentTime <= entry.endTime
  );

  if (!matchedEntry) {
    return { operating: false, operatingPeriod: null };
  }

  // Compute current period boundaries in UTC
  // Get today's date in the buyer's timezone
  const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  const dateStr = dateFormatter.format(now); // YYYY-MM-DD

  const startLocal = new Date(`${dateStr}T${matchedEntry.startTime}:00`);
  const endLocal = new Date(`${dateStr}T${matchedEntry.endTime}:00`);

  // Convert from local tz to UTC by computing the offset
  const utcNow = now.getTime();
  const localNow = new Date(
    now.toLocaleString("en-US", { timeZone: tz })
  ).getTime();
  const offset = localNow - utcNow;

  const startUtc = new Date(startLocal.getTime() - offset);
  const endUtc = new Date(endLocal.getTime() - offset);

  return {
    operating: true,
    operatingPeriod: {
      start: startUtc.toISOString(),
      end: endUtc.toISOString(),
    },
  };
}

/**
 * Resolve a slot's pricing tier: prefer pricingTierId lookup from offering tiers,
 * fall back to inline pricingTier field.
 */
function resolveSlotPricingTier(
  slot: { pricingTierId: string | null; pricingTier: unknown },
  offeringTiers: PricingTier[]
): PricingTier | null {
  if (slot.pricingTierId) {
    const found = offeringTiers.find(t => t.id === slot.pricingTierId);
    if (found) return found;
  }
  return (slot.pricingTier as PricingTier) ?? null;
}

/**
 * POST /verify - Verify device signature and return full installation data
 *
 * Combines the old verify, installation info, and slots endpoints into one.
 * No auth required — the BLE signature is the trust mechanism.
 */
buyerDevices.post(
  "/verify",
  zValidator("json", deviceVerifySchema),
  async c => {
    const { deviceWalletAddress, signedPayload, signature } =
      c.req.valid("json");
    const tz = c.req.query("tz") || "UTC";

    const proof = validateDeviceProofPayload(
      signedPayload,
      deviceWalletAddress
    );
    if (!proof.ok) {
      return c.json(errorResponse(proof.error), 400);
    }

    // Verify the device's signature
    const isValid = verifySignature(
      signedPayload,
      signature,
      deviceWalletAddress
    );
    if (!isValid) {
      return c.json(errorResponse("Invalid device signature"), 400);
    }
    seenDeviceProofs.set(proof.nonceKey, Date.now() + MAX_DEVICE_PROOF_AGE_MS);

    const db = getDb();

    // Find the installation + offering + model
    const [result] = await db
      .select({
        installation: vendorInstallations,
        offering: vendorOfferings,
        model: vendorModels,
      })
      .from(vendorInstallations)
      .innerJoin(
        vendorOfferings,
        eq(vendorInstallations.vendorOfferingId, vendorOfferings.id)
      )
      .innerJoin(
        vendorModels,
        eq(vendorOfferings.vendorModelId, vendorModels.id)
      )
      .where(eq(vendorInstallations.walletAddress, deviceWalletAddress))
      .limit(1);

    if (!result) {
      return c.json(errorResponse("Device not registered"), 404);
    }

    if (result.installation.status !== "Active") {
      return c.json(errorResponse("Device is not active"), 400);
    }

    const offeringTiers = result.offering.pricingTiers as PricingTier[];
    const schedule = result.offering.schedule as DailySchedule[] | null;

    // Evaluate operating hours
    const { operating, operatingPeriod } = evaluateOperating(schedule, tz);

    // Fetch slots
    const slots = await db
      .select()
      .from(vendorInstallationSlots)
      .where(
        and(
          eq(
            vendorInstallationSlots.installationWalletAddress,
            deviceWalletAddress
          ),
          eq(vendorInstallationSlots.status, "Active")
        )
      )
      .orderBy(vendorInstallationSlots.sortOrder);

    // Check slot availability (batch query for active orders)
    const slotIds = slots.map(s => s.id);
    let unavailableSlotIds = new Set<string>();

    if (slotIds.length > 0) {
      const activeOrders = await db
        .select({ slotId: orders.slotId })
        .from(orders)
        .where(
          and(
            inArray(orders.slotId, slotIds),
            inArray(orders.status, [...ACTIVE_ORDER_STATUSES])
          )
        );
      unavailableSlotIds = new Set(
        activeOrders
          .map(o => o.slotId)
          .filter((id): id is string => id !== null)
      );
    }

    const verifyData: BuyerVerifyResponse = {
      model: {
        name: result.model.name,
        slot: (result.model.slot as VendorModelSlot) ?? null,
        pricing: (result.model.pricing as VendorModelPricing) ?? null,
        slotPricing:
          (result.model.slotPricing as VendorModelSlotPricing) ?? null,
        action: (result.model.action as VendorModelAction) ?? null,
        interruption:
          (result.model.interruption as VendorModelInterruption) ?? null,
        payment: (result.model.payment as VendorModelPayment) ?? null,
      },
      installation: {
        name: result.installation.label,
      },
      offeringTiers,
      operating,
      operatingPeriod,
      slots: slots.map(slot => ({
        id: slot.id,
        label: slot.label,
        row: slot.row,
        column: slot.column,
        sortOrder: slot.sortOrder,
        pricingTier: resolveSlotPricingTier(slot, offeringTiers),
        available: !unavailableSlotIds.has(slot.id),
      })),
    };

    return c.json(successResponse(verifyData));
  }
);

export default buyerDevices;
