import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import {
  createCustomer,
  createSetupIntent,
  listPaymentMethods,
  detachPaymentMethod,
  setDefaultPaymentMethod,
} from "../../services/stripe.ts";
import { successResponse, errorResponse } from "@sudobility/types";
import type { AppEnv } from "../../lib/hono-types.ts";

const buyerPaymentMethods = new Hono<AppEnv>();

/** Ensure user has a Stripe customer ID, creating one if needed */
async function ensureStripeCustomer(firebaseUid: string): Promise<string> {
  const db = getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.firebaseUid, firebaseUid))
    .limit(1);

  if (!user) throw new Error("User not found");

  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await createCustomer({
    email: user.email,
    name: user.displayName,
    metadata: { firebaseUid },
  });

  await db
    .update(users)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(users.firebaseUid, firebaseUid));

  return customer.id;
}

/**
 * GET / - List saved payment methods
 */
buyerPaymentMethods.get("/", async c => {
  const firebaseUid = c.get("firebaseUid") as string;

  try {
    const customerId = await ensureStripeCustomer(firebaseUid);
    const methods = await listPaymentMethods(customerId);

    // Get customer to check default payment method
    const { getStripe } = await import("../../services/stripe.ts");
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(customerId);
    const defaultPmId =
      typeof customer !== "string" && !customer.deleted
        ? (customer.invoice_settings.default_payment_method as string | null)
        : null;

    const data = methods.map(pm => ({
      id: pm.id,
      brand: pm.card?.brand ?? "unknown",
      last4: pm.card?.last4 ?? "????",
      expMonth: pm.card?.exp_month ?? 0,
      expYear: pm.card?.exp_year ?? 0,
      isDefault: pm.id === defaultPmId,
    }));

    return c.json(successResponse(data));
  } catch (error: any) {
    return c.json(
      errorResponse(error.message ?? "Failed to list payment methods"),
      500
    );
  }
});

/**
 * POST /setup-intent - Create a SetupIntent for adding a new card
 */
buyerPaymentMethods.post("/setup-intent", async c => {
  const firebaseUid = c.get("firebaseUid") as string;
  console.log("[add-card] POST /setup-intent start", { firebaseUid });

  try {
    const customerId = await ensureStripeCustomer(firebaseUid);
    console.log("[add-card] resolved Stripe customer", {
      firebaseUid,
      customerId,
    });

    const setupIntent = await createSetupIntent(customerId);
    console.log("[add-card] SetupIntent created", {
      customerId,
      setupIntentId: setupIntent.id,
      status: setupIntent.status,
      hasClientSecret: Boolean(setupIntent.client_secret),
    });

    return c.json(successResponse({ clientSecret: setupIntent.client_secret }));
  } catch (error: any) {
    console.error("[add-card] failed to create setup intent", {
      firebaseUid,
      message: error?.message,
      type: error?.type,
      code: error?.code,
      stack: error?.stack,
    });
    return c.json(
      errorResponse(error.message ?? "Failed to create setup intent"),
      500
    );
  }
});

/**
 * DELETE /:id - Remove a payment method
 */
buyerPaymentMethods.delete("/:id", async c => {
  const paymentMethodId = c.req.param("id");
  const firebaseUid = c.get("firebaseUid") as string;

  try {
    // Verify the payment method belongs to this customer
    const customerId = await ensureStripeCustomer(firebaseUid);
    const methods = await listPaymentMethods(customerId);
    const belongs = methods.some(m => m.id === paymentMethodId);

    if (!belongs) {
      return c.json(errorResponse("Payment method not found"), 404);
    }

    await detachPaymentMethod(paymentMethodId);
    return c.json(successResponse(null));
  } catch (error: any) {
    return c.json(
      errorResponse(error.message ?? "Failed to delete payment method"),
      500
    );
  }
});

/**
 * PUT /:id/default - Set a payment method as default
 */
buyerPaymentMethods.put("/:id/default", async c => {
  const paymentMethodId = c.req.param("id");
  const firebaseUid = c.get("firebaseUid") as string;

  try {
    const customerId = await ensureStripeCustomer(firebaseUid);

    // Verify the payment method belongs to this customer
    const methods = await listPaymentMethods(customerId);
    const belongs = methods.some(m => m.id === paymentMethodId);

    if (!belongs) {
      return c.json(errorResponse("Payment method not found"), 404);
    }

    await setDefaultPaymentMethod(customerId, paymentMethodId);
    return c.json(successResponse(null));
  } catch (error: any) {
    return c.json(errorResponse(error.message ?? "Failed to set default"), 500);
  }
});

export default buyerPaymentMethods;
