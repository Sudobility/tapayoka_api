import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, desc, and, or, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  orders,
  authorizations,
  users,
  vendorDevices,
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

  // Get the offering's pricing tiers
  const [offering] = await db
    .select()
    .from(vendorOfferings)
    .where(eq(vendorOfferings.id, device.vendorOfferingId))
    .limit(1);

  if (!offering) {
    return c.json(errorResponse("Offering not found"), 404);
  }

  // Find the matching pricing tier
  const tiers = offering.pricingTiers as PricingTier[];
  const tier = tiers.find(t => t.id === pricingTierId);
  if (!tier) {
    return c.json(errorResponse("Pricing tier not found"), 404);
  }

  // Validate amount
  const minCents = tierMinCents(tier);

  if (amountCents < minCents) {
    return c.json(
      errorResponse(
        `Amount ${amountCents} is less than minimum price ${minCents}`
      ),
      400
    );
  }

  // Validate slot if provided
  if (slotId) {
    const [slot] = await db
      .select()
      .from(vendorDeviceSlots)
      .where(
        and(
          eq(vendorDeviceSlots.id, slotId),
          eq(vendorDeviceSlots.deviceWalletAddress, deviceWalletAddress)
        )
      )
      .limit(1);

    if (!slot) {
      return c.json(errorResponse("Slot not found"), 404);
    }

    // Check slot availability. A slot is "in use" only by a live order: one
    // that's RUNNING, or pre-running (CREATED/PAID/AUTHORIZED) and updated
    // recently. Pre-running orders that got stuck (never paid, or activation
    // failed after payment) auto-release after the staleness window so a slot
    // is never blocked forever.
    const staleCutoff = new Date(Date.now() - SLOT_HOLD_STALE_MS);
    const [activeOrder] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.slotId, slotId),
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
      const paymentIntent = await createPaymentIntent(
        order.amountCents,
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
