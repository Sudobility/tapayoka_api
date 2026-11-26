import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, desc, and, or, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  orders,
  authorizations,
  users,
  vendorDevices,
  vendorModels,
  vendorOfferings,
  vendorDeviceSlots,
} from "../../db/schema.ts";
import {
  createOrderSchema,
  processPaymentSchema,
  uuidSchema,
} from "../../schemas/index.ts";
import {
  createPaymentIntent,
  confirmPayment,
  refundPayment,
} from "../../services/stripe.ts";
import { signPayload, getServerAddress } from "../../services/crypto.ts";
import {
  successResponse,
  piSuccessResponse,
  errorResponse,
  calculateAuthorizedSeconds,
  tierMinCents,
  priceStringToCents,
  type PricingTier,
  type AuthorizationPayload,
  type PiCommand,
  type Order,
} from "@sudobility/tapayoka_types";
import { resolveTierForOrder } from "../../services/resolveTier.ts";
import { randomUUID } from "crypto";
import type { AppEnv } from "../../lib/hono-types.ts";

const buyerOrders = new Hono<AppEnv>();

// Pre-running statuses that hold a slot. An order in one of these that hasn't
// been touched within the staleness window is treated as abandoned (e.g. the
// buyer never paid, or device activation failed after payment) and no longer
// blocks the slot.
const PRE_RUNNING_STATUSES = ["CREATED", "PAID", "AUTHORIZED"] as const;
const SLOT_HOLD_STALE_MS = 10 * 60 * 1000; // 10 minutes

// A sanity ceiling so a client bug or bad input can't authorize an absurd
// amount or run time. No legitimate single order approaches this.
const MAX_ORDER_AMOUNT_CENTS = 1_000_000; // $10,000

/**
 * Resolve the tier an order refers to: a tier from the offering's menu, or
 * (for a custom-priced slot) the slot's own embedded tier. Mirrors buyer verify
 * and authorization, which both understand per-slot custom tiers.
 */
function pickOrderTier(
  offeringTiers: PricingTier[],
  slotPricingTier: unknown,
  pricingTierId: string
): PricingTier | null {
  const fromOffering = offeringTiers.find(t => t.id === pricingTierId);
  if (fromOffering) return fromOffering;
  const custom = (slotPricingTier as PricingTier | null) ?? null;
  return custom && custom.id === pricingTierId ? custom : null;
}

/**
 * Whether `amountCents` is a charge the tier can actually produce: a fixed tier
 * is its exact price; a timed tier is the start price plus a whole number of
 * marginal steps. Prevents charging an arbitrary client amount (and the
 * partial-step overcharge that flooring to whole steps would otherwise hide).
 */
function isAmountValidForTier(tier: PricingTier, amountCents: number): boolean {
  const minCents = tierMinCents(tier);
  if (amountCents < minCents) return false;
  if (tier.type === "fixed") return amountCents === minCents;
  const marginalCents = priceStringToCents(tier.marginalPrice);
  if (marginalCents <= 0) return amountCents === minCents;
  return (amountCents - minCents) % marginalCents === 0;
}

/**
 * Re-resolve an order's tier after creation (used for its currency at charge
 * time). Loads the device's offering and the order's slot, then picks the tier.
 */
async function resolveOrderTier(
  db: ReturnType<typeof getDb>,
  order: {
    deviceWalletAddress: string;
    slotId: string | null;
    pricingTierId: string | null;
  }
): Promise<PricingTier | null> {
  if (!order.pricingTierId) return null;
  const [device] = await db
    .select({ offeringId: vendorDevices.vendorOfferingId })
    .from(vendorDevices)
    .where(eq(vendorDevices.walletAddress, order.deviceWalletAddress))
    .limit(1);
  if (!device) return null;
  const [offering] = await db
    .select({ pricingTiers: vendorOfferings.pricingTiers })
    .from(vendorOfferings)
    .where(eq(vendorOfferings.id, device.offeringId))
    .limit(1);
  let slotTier: unknown = null;
  if (order.slotId) {
    const [s] = await db
      .select({ pricingTier: vendorDeviceSlots.pricingTier })
      .from(vendorDeviceSlots)
      .where(eq(vendorDeviceSlots.id, order.slotId))
      .limit(1);
    slotTier = s?.pricingTier ?? null;
  }
  return pickOrderTier(
    (offering?.pricingTiers as PricingTier[]) ?? [],
    slotTier,
    order.pricingTierId
  );
}

/** Create an authorization for an order and return a PiCommand ready to relay */
async function createAuthorizationForOrder(
  db: ReturnType<typeof getDb>,
  order: {
    id: string;
    pricingTierId: string | null;
    deviceWalletAddress: string;
    authorizedSeconds: number;
    slotId?: string | null;
  }
): Promise<PiCommand> {
  const { offeringType, signals, end } = await resolveTierForOrder(db, order);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const payload: AuthorizationPayload = {
    orderId: order.id,
    offeringType,
    seconds: order.authorizedSeconds,
    ...(signals ? { signals } : {}),
    ...(end ? { end } : {}),
    nonce: randomUUID(),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };

  const payloadJson = JSON.stringify(payload);
  const serverSignature = await signPayload(payloadJson);

  await db.insert(authorizations).values({
    orderId: order.id,
    payloadJson,
    serverSignature,
    expiresAt,
  });

  await db
    .update(orders)
    .set({ status: "AUTHORIZED", updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  return {
    command: "EXECUTE",
    data: payload as unknown as Record<string, unknown>,
    signing: {
      walletAddress: getServerAddress(),
      message: payloadJson,
      signature: serverSignature,
    },
  };
}

/**
 * GET / - List orders for the authenticated buyer
 */
buyerOrders.get("/", async c => {
  const buyerUid = c.get("firebaseUid") as string;
  const db = getDb();

  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.buyerUid, buyerUid))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  const data: Order[] = rows;
  return c.json(successResponse(data));
});

/**
 * POST / - Create a new order
 */
buyerOrders.post("/", zValidator("json", createOrderSchema), async c => {
  const { deviceWalletAddress, pricingTierId, amountCents, slotId } =
    c.req.valid("json");
  const buyerUid = c.get("firebaseUid") as string;

  const db = getDb();

  // Validate device exists and is active
  const [device] = await db
    .select()
    .from(vendorDevices)
    .where(eq(vendorDevices.walletAddress, deviceWalletAddress))
    .limit(1);

  if (!device || device.status !== "Active") {
    return c.json(errorResponse("Device not found or inactive"), 404);
  }

  // Load the offering (its pricing-tier menu) and the model (payment rules).
  const [offering] = await db
    .select()
    .from(vendorOfferings)
    .where(eq(vendorOfferings.id, device.vendorOfferingId))
    .limit(1);

  if (!offering) {
    return c.json(errorResponse("Offering not found"), 404);
  }

  const [model] = await db
    .select({ payment: vendorModels.payment })
    .from(vendorModels)
    .where(eq(vendorModels.id, offering.vendorModelId))
    .limit(1);

  // Pay-at-end (two-phase, e.g. lockers) isn't implemented: the only payment
  // path charges up front, so reject rather than silently charge at start.
  if (model?.payment === "atEnd") {
    return c.json(
      errorResponse("This device is not available for purchase yet"),
      400
    );
  }

  // Load the slot once (if given): used both for its custom price and the
  // availability check below.
  let slot: { id: string; pricingTier: unknown } | undefined;
  if (slotId) {
    const [row] = await db
      .select({
        id: vendorDeviceSlots.id,
        pricingTier: vendorDeviceSlots.pricingTier,
      })
      .from(vendorDeviceSlots)
      .where(
        and(
          eq(vendorDeviceSlots.id, slotId),
          eq(vendorDeviceSlots.deviceWalletAddress, deviceWalletAddress)
        )
      )
      .limit(1);

    if (!row) {
      return c.json(errorResponse("Slot not found"), 404);
    }
    slot = row;
  }

  // Resolve the tier: an offering-menu tier, or (for a custom-priced slot) the
  // slot's own embedded tier.
  const tiers = offering.pricingTiers as PricingTier[];
  const tier = pickOrderTier(tiers, slot?.pricingTier ?? null, pricingTierId);
  if (!tier) {
    return c.json(errorResponse("Pricing tier not found"), 404);
  }

  // Validate the amount against the tier: no more than the sanity ceiling, and
  // a value the tier can actually produce (the server never charges an
  // arbitrary client-supplied amount).
  if (amountCents > MAX_ORDER_AMOUNT_CENTS) {
    return c.json(
      errorResponse(`Amount exceeds the maximum of ${MAX_ORDER_AMOUNT_CENTS}`),
      400
    );
  }
  if (!isAmountValidForTier(tier, amountCents)) {
    return c.json(
      errorResponse(`Amount ${amountCents} is not valid for this pricing tier`),
      400
    );
  }

  // Check slot availability (slot already loaded). A slot is "in use" only by a
  // live order: RUNNING, or pre-running (CREATED/PAID/AUTHORIZED) and updated
  // recently. Pre-running orders that got stuck (never paid, or activation
  // failed after payment) auto-release after the staleness window so a slot is
  // never blocked forever.
  if (slot) {
    const staleCutoff = new Date(Date.now() - SLOT_HOLD_STALE_MS);
    const [activeOrder] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.slotId, slot.id),
          or(
            eq(orders.status, "RUNNING"),
            and(
              inArray(orders.status, PRE_RUNNING_STATUSES),
              gte(orders.updatedAt, staleCutoff)
            )
          )
        )
      )
      .limit(1);

    if (activeOrder) {
      return c.json(errorResponse("Slot is currently in use"), 409);
    }
  }

  const authorizedSeconds = calculateAuthorizedSeconds(tier, amountCents);

  // Create order
  const [order] = await db
    .insert(orders)
    .values({
      deviceWalletAddress,
      pricingTierId,
      buyerUid,
      amountCents,
      authorizedSeconds,
      ...(slotId ? { slotId } : {}),
    })
    .returning();

  const data: Order = order;
  return c.json(successResponse(data), 201);
});

/**
 * GET /:id - Get order by ID
 */
buyerOrders.get("/:id", async c => {
  const orderId = c.req.param("id");
  const buyerUid = c.get("firebaseUid") as string;
  const parsed = uuidSchema.safeParse(orderId);
  if (!parsed.success) {
    return c.json(errorResponse("Invalid order ID"), 400);
  }

  const db = getDb();
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) {
    return c.json(errorResponse("Order not found"), 404);
  }
  if (order.buyerUid !== buyerUid) {
    return c.json(errorResponse("Forbidden"), 403);
  }

  const data: Order = order;
  return c.json(successResponse(data));
});

/**
 * POST /:id/pay - Process payment for an order
 */
buyerOrders.post(
  "/:id/pay",
  zValidator("json", processPaymentSchema),
  async c => {
    const { orderId, paymentMethodId } = c.req.valid("json");
    const routeOrderId = c.req.param("id");
    const buyerUid = c.get("firebaseUid") as string;

    if (routeOrderId !== orderId) {
      return c.json(errorResponse("Route order ID does not match body"), 400);
    }

    const db = getDb();
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) {
      return c.json(errorResponse("Order not found"), 404);
    }
    if (order.buyerUid !== buyerUid) {
      return c.json(errorResponse("Forbidden"), 403);
    }

    if (order.status !== "CREATED") {
      return c.json(errorResponse("Order is not in CREATED status"), 400);
    }

    // The saved payment method is attached to the buyer's Stripe customer,
    // which must be set on the PaymentIntent to confirm with that method.
    if (!order.buyerUid) {
      return c.json(errorResponse("Order has no buyer"), 400);
    }
    const [buyer] = await db
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.firebaseUid, order.buyerUid))
      .limit(1);
    if (!buyer?.stripeCustomerId) {
      return c.json(errorResponse("Buyer has no payment account"), 400);
    }

    try {
      // Charge in the tier's currency, not a hardcoded one.
      const tier = await resolveOrderTier(db, order);
      const currency = (tier?.currencyCode ?? "USD").toLowerCase();

      const paymentIntent = await createPaymentIntent(
        order.amountCents,
        currency,
        {
          orderId: order.id,
          deviceWalletAddress: order.deviceWalletAddress,
        },
        buyer.stripeCustomerId
      );

      const confirmed = await confirmPayment(paymentIntent.id, paymentMethodId);

      if (confirmed.status === "succeeded") {
        const [paidRow] = await db
          .update(orders)
          .set({
            status: "PAID",
            stripePaymentIntentId: paymentIntent.id,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, orderId))
          .returning();

        const paidOrder: Order = paidRow;

        // Create authorization and build PiCommand for the device
        const piCommand = await createAuthorizationForOrder(db, paidOrder);

        return c.json(piSuccessResponse(paidOrder, piCommand));
      } else {
        return c.json(
          errorResponse(`Payment status: ${confirmed.status}`),
          400
        );
      }
    } catch (error: any) {
      await db
        .update(orders)
        .set({ status: "FAILED", updatedAt: new Date() })
        .where(eq(orders.id, orderId));

      return c.json(
        errorResponse(error.message ?? "Payment processing failed"),
        400
      );
    }
  }
);

/**
 * POST /:id/cancel - Release an order that never started.
 *
 * Called by the buyer app when device activation fails after payment, so the
 * slot is freed immediately instead of waiting for the staleness window. If the
 * order was already charged, the payment is refunded.
 */
buyerOrders.post("/:id/cancel", async c => {
  const orderId = c.req.param("id");
  const buyerUid = c.get("firebaseUid") as string;
  const db = getDb();

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) {
    return c.json(errorResponse("Order not found"), 404);
  }
  if (order.buyerUid !== buyerUid) {
    return c.json(errorResponse("Forbidden"), 403);
  }
  if (!(PRE_RUNNING_STATUSES as readonly string[]).includes(order.status)) {
    return c.json(
      errorResponse(`Cannot cancel an order in ${order.status} status`),
      400
    );
  }

  // Refund if the card was already charged (PAID/AUTHORIZED).
  if (order.stripePaymentIntentId) {
    try {
      await refundPayment(order.stripePaymentIntentId);
    } catch (error: any) {
      return c.json(
        errorResponse(error?.message ?? "Failed to refund payment"),
        502
      );
    }
  }

  const [updated] = await db
    .update(orders)
    .set({ status: "FAILED", updatedAt: new Date() })
    .where(eq(orders.id, orderId))
    .returning();

  const data: Order = updated;
  return c.json(successResponse(data));
});

export default buyerOrders;
