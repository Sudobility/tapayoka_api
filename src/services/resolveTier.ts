import { eq } from "drizzle-orm";
import type {
  OfferingType,
  PricingTier,
  SlotAction,
} from "@sudobility/tapayoka_types";
import { getDb } from "../db/index.ts";
import {
  offerings,
  vendorDevices,
  vendorDeviceSlots,
  vendorOfferings,
} from "../db/schema.ts";
import {
  slotAuthorizationFields,
  type TierAuthorizationFields,
} from "./authorizationPayload.ts";

/**
 * Resolve the authorization fields for an order.
 *
 * The relay behaviour ("action") is resolved as `slot.action ?? tier.action`:
 * multi-slot models carry per-slot pins on the slot; single-slot models keep
 * the action on the tier. The tier itself is the offering tier referenced by
 * `pricingTierId`, or (for Unique slots) the slot's own embedded `pricingTier`.
 * `authorizedSeconds` becomes the hold time for a timed action.
 */
export async function resolveTierForOrder(
  db: ReturnType<typeof getDb>,
  order: {
    offeringId?: string | null;
    pricingTierId: string | null;
    deviceWalletAddress: string;
    slotId?: string | null;
    authorizedSeconds?: number;
  }
): Promise<TierAuthorizationFields> {
  const seconds = order.authorizedSeconds ?? 0;

  // Load the slot first — its action (multi-slot) and its embedded tier (Unique).
  let slot: { action: SlotAction | null; pricingTier: unknown } | null = null;
  if (order.slotId) {
    const [row] = await db
      .select()
      .from(vendorDeviceSlots)
      .where(eq(vendorDeviceSlots.id, order.slotId))
      .limit(1);
    slot = row
      ? {
          action: row.action as SlotAction | null,
          pricingTier: row.pricingTier,
        }
      : null;
  }

  if (order.pricingTierId || slot) {
    const [device] = await db
      .select()
      .from(vendorDevices)
      .where(eq(vendorDevices.walletAddress, order.deviceWalletAddress))
      .limit(1);
    if (device) {
      const [offering] = await db
        .select()
        .from(vendorOfferings)
        .where(eq(vendorOfferings.id, device.vendorOfferingId))
        .limit(1);
      if (offering) {
        const tiers = offering.pricingTiers as PricingTier[];
        // Prefer the referenced offering tier (Tiered); fall back to the slot's
        // own embedded tier (Unique).
        const tier =
          tiers.find(t => t.id === order.pricingTierId) ??
          (slot?.pricingTier as PricingTier | undefined) ??
          null;
        if (tier || slot?.action) {
          return slotAuthorizationFields(slot, tier, seconds);
        }
      }
    }
  }

  // Legacy fallback: resolve type from the offerings table (no signals available).
  if (order.offeringId) {
    const [offering] = await db
      .select()
      .from(offerings)
      .where(eq(offerings.id, order.offeringId))
      .limit(1);
    if (offering) {
      return { offeringType: offering.type as OfferingType };
    }
  }

  return { offeringType: "TRIGGER" };
}
