import { z } from "zod";

// =============================================================================
// Validation Schemas (Zod)
// =============================================================================

export const ethAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address");

export const uuidSchema = z.string().uuid("Invalid UUID");

// Buyer schemas
export const deviceVerifySchema = z.object({
  deviceWalletAddress: ethAddressSchema,
  signedPayload: z.string().min(1),
  signature: z.string().min(1),
});

export const createOrderSchema = z.object({
  deviceWalletAddress: ethAddressSchema,
  pricingTierId: z.string().min(1),
  amountCents: z.number().int().positive(),
  slotId: z.string().uuid().optional(),
});

export const processPaymentSchema = z.object({
  orderId: uuidSchema,
  paymentMethodId: z.string().min(1),
});

export const createAuthorizationSchema = z.object({
  orderId: uuidSchema,
});

export const telemetryEventSchema = z.object({
  deviceWalletAddress: ethAddressSchema,
  direction: z.enum(["PI_TO_SRV", "SRV_TO_PI"]),
  ok: z.boolean(),
  details: z.string().optional(),
});

// Vendor management schemas
export const vendorLocationCreateSchema = z.object({
  name: z.string().min(1).max(255),
  address: z.string().min(1).max(255),
  city: z.string().min(1).max(255),
  stateProvince: z.string().min(1).max(255),
  zipcode: z.string().min(1).max(20),
  country: z.string().min(1).max(100),
});

export const vendorLocationUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  address: z.string().min(1).max(255).optional(),
  city: z.string().min(1).max(255).optional(),
  stateProvince: z.string().min(1).max(255).optional(),
  zipcode: z.string().min(1).max(20).optional(),
  country: z.string().min(1).max(100).optional(),
});

const dailyScheduleSchema = z.object({
  dayOfWeek: z.enum([
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
});

export const vendorModelCreateSchema = z.object({
  name: z.string().min(1).max(255),
  type: z
    .enum([
      "Washer",
      "Dryer",
      "Parking",
      "Charging",
      "Locker",
      "Vending",
      "Tourist Binocular",
    ])
    .optional(),
  pricing: z.enum(["fixed", "variable"]).optional(),
  slot: z.enum(["single", "multi1D", "multi2D"]).optional(),
  slotPricing: z.enum(["Tiered", "Unique"]).optional(),
  action: z.enum(["timed", "sequence"]).optional(),
  interruption: z.enum(["stop", "continue"]).optional(),
  payment: z.enum(["atStart", "atEnd"]).optional(),
});

export const vendorModelUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z
    .enum([
      "Washer",
      "Dryer",
      "Parking",
      "Charging",
      "Locker",
      "Vending",
      "Tourist Binocular",
    ])
    .optional(),
  pricing: z.enum(["fixed", "variable"]).optional(),
  slot: z.enum(["single", "multi1D", "multi2D"]).optional(),
  slotPricing: z.enum(["Tiered", "Unique"]).optional(),
  action: z.enum(["timed", "sequence"]).optional(),
  interruption: z.enum(["stop", "continue"]).optional(),
  payment: z.enum(["atStart", "atEnd"]).optional(),
});

const offeringSignalSchema = z.object({
  pinNumber: z.number().int().min(0).max(25),
  duration: z.number().int().positive(),
});

// Relay signal for a SlotAction phase. Allows duration 0 (a timed hold's start
// pin, whose run time comes from the purchased seconds) and the full BCM pin
// range the device supports (0–27).
const actionSignalSchema = z.object({
  pinNumber: z.number().int().min(0).max(27),
  duration: z.number().int().min(0),
});

const slotActionSchema = z.object({
  type: z.enum(["timed", "sequence"]),
  start: z.array(actionSignalSchema).min(1),
  end: z.array(actionSignalSchema).optional(),
});

const timedPricingTierSchema = z.object({
  type: z.literal("timed"),
  id: z.string().min(1),
  name: z.string().min(1).max(255),
  currencyCode: z.string().length(3),
  startPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
  startDuration: z.number().int().positive(),
  startDurationUnit: z.enum(["minutes", "hours"]),
  marginalPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
  marginalDuration: z.number().int().positive(),
  marginalDurationUnit: z.enum(["minutes", "hours"]),
  // Relay behaviour for single-slot models; pinNumber is the legacy carrier.
  action: slotActionSchema.optional(),
  pinNumber: z.number().int().min(0).max(27).optional(),
});

const fixedPricingTierSchema = z.object({
  type: z.literal("fixed"),
  id: z.string().min(1),
  name: z.string().min(1).max(255),
  currencyCode: z.string().length(3),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/),
  // Relay behaviour for single-slot models; signals is the legacy carrier.
  action: slotActionSchema.optional(),
  signals: z.array(offeringSignalSchema).optional(),
});

const pricingTierSchema = z.discriminatedUnion("type", [
  timedPricingTierSchema,
  fixedPricingTierSchema,
]);

export const vendorOfferingCreateSchema = z.object({
  vendorLocationId: uuidSchema,
  vendorModelId: uuidSchema,
  name: z.string().min(1).max(255),
  pricingTiers: z.array(pricingTierSchema),
  schedule: z.array(dailyScheduleSchema).optional(),
});

export const vendorOfferingUpdateSchema = z.object({
  vendorLocationId: uuidSchema.optional(),
  vendorModelId: uuidSchema.optional(),
  name: z.string().min(1).max(255).optional(),
  pricingTiers: z.array(pricingTierSchema).optional(),
  schedule: z.array(dailyScheduleSchema).nullable().optional(),
});

const ethSignedMessageSchema = z.object({
  walletAddress: ethAddressSchema,
  message: z.string().min(1),
  signature: z.string().min(1),
});

export const vendorDeviceCreateSchema = z.object({
  deviceProof: z.object({
    data: z
      .object({
        walletAddress: ethAddressSchema,
      })
      .passthrough(),
    signing: ethSignedMessageSchema,
  }),
  vendorOfferingId: uuidSchema,
  label: z.string().min(1).max(255),
  connectionString: z.string().max(500).optional(),
});

export const vendorDeviceUpdateSchema = z.object({
  label: z.string().min(1).max(255).optional(),
  vendorOfferingId: uuidSchema.optional(),
});

// Vendor device slot schemas
export const vendorDeviceSlotCreateSchema = z.object({
  label: z.string().min(1).max(255),
  row: z.string().max(50).optional(),
  column: z.string().max(50).optional(),
  sortOrder: z.number().int().min(0).optional(),
  pricingTierId: z.string().min(1).optional(),
  pricingTier: pricingTierSchema.optional(),
  action: slotActionSchema.nullable().optional(),
});

export const vendorDeviceSlotUpdateSchema = z.object({
  label: z.string().min(1).max(255).optional(),
  row: z.string().max(50).nullable().optional(),
  column: z.string().max(50).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  pricingTierId: z.string().min(1).nullable().optional(),
  pricingTier: pricingTierSchema.nullable().optional(),
  action: slotActionSchema.nullable().optional(),
});

export const vendorDeviceSlotBulkCreateSchema = z.object({
  rows: z.array(z.string().min(1).max(50)).min(1).max(26),
  columns: z.array(z.string().min(1).max(50)).min(1).max(50),
});

// Entity schemas
export const entitySlugParamSchema = z.object({
  entitySlug: z.string().min(1),
});

export const entityCreateSchema = z.object({
  displayName: z.string().optional(),
  acceptTos: z.literal(true),
});
