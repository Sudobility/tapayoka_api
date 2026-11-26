import Stripe from "stripe";
import { getEnv } from "../lib/env-helper.ts";

let stripeClient: Stripe | null = null;

/** Get or initialize the Stripe client */
export function getStripe(): Stripe {
  if (!stripeClient) {
    const secretKey = getEnv("STRIPE_SECRET_KEY");
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    stripeClient = new Stripe(secretKey);
  }
  return stripeClient;
}

/** Create a payment intent for an order. `currency` is a lowercase ISO code
 *  (e.g. "usd") derived from the pricing tier's currencyCode. */
export async function createPaymentIntent(
  amountCents: number,
  currency: string,
  metadata: Record<string, string>,
  customerId: string
): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  return stripe.paymentIntents.create({
    amount: amountCents,
    currency,
    metadata,
    // The saved card is attached to this customer; Stripe requires the
    // customer on the PaymentIntent to confirm with an attached method.
    customer: customerId,
    // Card-only flow confirmed server-side: disable redirect-based methods
    // so no return_url is required at confirm time.
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  });
}

/** Confirm a payment intent with a saved (off-session) payment method */
export async function confirmPayment(
  paymentIntentId: string,
  paymentMethodId: string
): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  return stripe.paymentIntents.confirm(paymentIntentId, {
    payment_method: paymentMethodId,
    // Saved card charged without the customer completing a UI step.
    off_session: true,
  });
}

/** Refund a captured payment (used when an order is released after charge) */
export async function refundPayment(
  paymentIntentId: string
): Promise<Stripe.Refund> {
  const stripe = getStripe();
  return stripe.refunds.create({ payment_intent: paymentIntentId });
}

/** Create a Stripe customer */
export async function createCustomer(params: {
  email?: string | null;
  name?: string | null;
  metadata?: Record<string, string>;
}): Promise<Stripe.Customer> {
  const stripe = getStripe();
  return stripe.customers.create({
    email: params.email ?? undefined,
    name: params.name ?? undefined,
    metadata: params.metadata,
  });
}

/** Create a SetupIntent for saving a payment method to a customer */
export async function createSetupIntent(
  customerId: string
): Promise<Stripe.SetupIntent> {
  const stripe = getStripe();
  return stripe.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    // Card-only: avoid redirect-based methods that would require a return_url.
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  });
}

/** List payment methods for a customer */
export async function listPaymentMethods(
  customerId: string
): Promise<Stripe.PaymentMethod[]> {
  const stripe = getStripe();
  const result = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
  });
  return result.data;
}

/** Detach a payment method from its customer */
export async function detachPaymentMethod(
  paymentMethodId: string
): Promise<Stripe.PaymentMethod> {
  const stripe = getStripe();
  return stripe.paymentMethods.detach(paymentMethodId);
}

/** Set a customer's default payment method */
export async function setDefaultPaymentMethod(
  customerId: string,
  paymentMethodId: string
): Promise<Stripe.Customer> {
  const stripe = getStripe();
  return stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}
