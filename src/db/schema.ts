import {
  pgSchema,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import {
  createEntitiesTable,
  createEntityMembersTable,
  createEntityInvitationsTable,
} from "@sudobility/entity_service";

// PostgreSQL schema namespace
export const tapayoka = pgSchema("tapayoka");

// =============================================================================
// Enums
// =============================================================================

export const offeringTypeEnum = tapayoka.enum("offering_type", [
  "TRIGGER",
  "FIXED",
  "TIMED",
]);

export const orderStatusEnum = tapayoka.enum("order_status", [
  "CREATED",
  "PAID",
  "AUTHORIZED",
  "RUNNING",
  "DONE",
  "FAILED",
]);

export const userRoleEnum = tapayoka.enum("user_role", ["vendor", "buyer"]);

export const logDirectionEnum = tapayoka.enum("log_direction", [
  "PI_TO_SRV",
  "SRV_TO_PI",
]);

export const vendorModelTypeEnum = tapayoka.enum("vendor_model_type", [
  "Washer",
  "Dryer",
  "Parking",
  "Charging",
  "Locker",
  "Vending",
  "Tourist Binocular",
]);

export const vendorModelPricingEnum = tapayoka.enum("vendor_model_pricing", [
  "fixed",
  "variable",
]);

export const vendorModelActionEnum = tapayoka.enum("vendor_model_action", [
  "timed",
  "sequence",
]);

export const vendorModelInterruptionEnum = tapayoka.enum(
  "vendor_model_interruption",
  ["stop", "continue"]
);

export const vendorModelPaymentEnum = tapayoka.enum("vendor_model_payment", [
  "atStart",
  "atEnd",
]);

export const vendorModelSlotEnum = tapayoka.enum("vendor_model_slot", [
  "single",
  "multi1D",
  "multi2D",
]);

export const vendorModelSlotPricingEnum = tapayoka.enum(
  "vendor_model_slot_pricing",
  ["Same", "Different", "Tiered", "Unique"]
);

export const vendorEntityStatusEnum = tapayoka.enum("vendor_entity_status", [
  "Active",
  "Inactive",
  "Deleted",
]);

// =============================================================================
// Entity Tables (from entity_service)
// =============================================================================

export const entities = createEntitiesTable(tapayoka, "tapayoka");
export const entityMembers = createEntityMembersTable(tapayoka, "tapayoka");
export const entityInvitations = createEntityInvitationsTable(
  tapayoka,
  "tapayoka"
);

// =============================================================================
// Tables
// =============================================================================

export const users = tapayoka.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  firebaseUid: varchar("firebase_uid", { length: 128 }).notNull().unique(),
  email: varchar("email", { length: 255 }),
  displayName: varchar("display_name", { length: 255 }),
  role: userRoleEnum("role").notNull().default("buyer"),
  stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
  tosAcceptedAt: timestamp("tos_accepted_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Snake-cased Drizzle view of the same physical `tapayoka.users` table for
 * @sudobility/entity_service. The member/invitation helpers reference columns
 * by the JS keys `firebase_uid` / `display_name` (matching their internal
 * joins), whereas the app-facing `users` table above uses camelCase keys. Both
 * map to the identical physical columns, so this is a key-naming alias only —
 * no extra table. Pass this as `usersTable` in the entity helpers config.
 */
export const entityServiceUsers = tapayoka.table("users", {
  firebase_uid: varchar("firebase_uid", { length: 128 }).notNull().unique(),
  email: varchar("email", { length: 255 }),
  display_name: varchar("display_name", { length: 255 }),
});

export const offerings = tapayoka.table(
  "offerings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    type: offeringTypeEnum("type").notNull(),
    priceCents: integer("price_cents").notNull(),
    fixedMinutes: integer("fixed_minutes"),
    minutesPer25c: integer("minutes_per_25c"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [index("offerings_entity_idx").on(table.entityId)]
);

export const deviceOfferings = tapayoka.table(
  "device_offerings",
  {
    deviceWalletAddress: varchar("device_wallet_address", { length: 42 })
      .notNull()
      .references(() => vendorDevices.walletAddress, {
        onDelete: "cascade",
      }),
    offeringId: uuid("offering_id")
      .notNull()
      .references(() => offerings.id, { onDelete: "cascade" }),
  },
  table => [
    unique("device_offerings_unique").on(
      table.deviceWalletAddress,
      table.offeringId
    ),
  ]
);

export const orders = tapayoka.table(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceWalletAddress: varchar("device_wallet_address", { length: 42 })
      .notNull()
      .references(() => vendorDevices.walletAddress),
    offeringId: uuid("offering_id").references(() => offerings.id),
    pricingTierId: varchar("pricing_tier_id", { length: 255 }),
    buyerUid: varchar("buyer_uid", { length: 128 }),
    amountCents: integer("amount_cents").notNull(),
    authorizedSeconds: integer("authorized_seconds").notNull().default(0),
    status: orderStatusEnum("status").notNull().default("CREATED"),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", {
      length: 255,
    }),
    slotId: uuid("slot_id").references(() => vendorDeviceSlots.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [
    index("orders_device_idx").on(table.deviceWalletAddress),
    index("orders_status_idx").on(table.status),
  ]
);

export const authorizations = tapayoka.table(
  "authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: "cascade" }),
    payloadJson: text("payload_json").notNull(),
    serverSignature: text("server_signature").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  table => [index("authorizations_order_idx").on(table.orderId)]
);

export const deviceLogs = tapayoka.table(
  "device_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceWalletAddress: varchar("device_wallet_address", { length: 42 })
      .notNull()
      .references(() => vendorDevices.walletAddress),
    direction: logDirectionEnum("direction").notNull(),
    ok: boolean("ok").notNull().default(true),
    details: text("details"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  table => [index("device_logs_device_idx").on(table.deviceWalletAddress)]
);

export const adminLogs = tapayoka.table(
  "admin_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 128 }).notNull(),
    action: varchar("action", { length: 255 }).notNull(),
    entityType: varchar("entity_type", { length: 100 }),
    entityId: varchar("entity_id", { length: 255 }),
    details: text("details"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  table => [index("admin_logs_user_idx").on(table.userId)]
);

// =============================================================================
// Vendor Management Tables
// =============================================================================

export const vendorLocations = tapayoka.table(
  "vendor_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    address: varchar("address", { length: 255 }).notNull(),
    city: varchar("city", { length: 255 }).notNull(),
    stateProvince: varchar("state_province", { length: 255 }).notNull(),
    zipcode: varchar("zipcode", { length: 20 }).notNull(),
    country: varchar("country", { length: 100 }).notNull(),
    status: vendorEntityStatusEnum("status").notNull().default("Active"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [index("vendor_locations_entity_idx").on(table.entityId)]
);

export const vendorModels = tapayoka.table(
  "vendor_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    type: vendorModelTypeEnum("type"),
    pricing: vendorModelPricingEnum("pricing"),
    slot: vendorModelSlotEnum("slot"),
    slotPricing: vendorModelSlotPricingEnum("slot_pricing"),
    action: vendorModelActionEnum("action"),
    interruption: vendorModelInterruptionEnum("interruption"),
    payment: vendorModelPaymentEnum("payment"),
    status: vendorEntityStatusEnum("status").notNull().default("Active"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [index("vendor_models_entity_idx").on(table.entityId)]
);

export const vendorOfferings = tapayoka.table(
  "vendor_offerings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorLocationId: uuid("vendor_location_id")
      .notNull()
      .references(() => vendorLocations.id),
    vendorModelId: uuid("vendor_model_id")
      .notNull()
      .references(() => vendorModels.id),
    name: varchar("name", { length: 255 }).notNull(),
    pricingTiers: jsonb("pricing_tiers").notNull(),
    schedule: jsonb("schedule"),
    status: vendorEntityStatusEnum("status").notNull().default("Active"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [
    unique("vendor_offerings_location_model_unique").on(
      table.vendorLocationId,
      table.vendorModelId
    ),
    index("vendor_offerings_location_idx").on(table.vendorLocationId),
    index("vendor_offerings_model_idx").on(table.vendorModelId),
  ]
);

export const vendorDevices = tapayoka.table(
  "vendor_devices",
  {
    walletAddress: varchar("wallet_address", { length: 42 })
      .primaryKey()
      .notNull(),
    vendorOfferingId: uuid("vendor_offering_id")
      .notNull()
      .references(() => vendorOfferings.id),
    label: varchar("label", { length: 255 }).notNull(),
    connectionString: text("connection_string"),
    status: vendorEntityStatusEnum("status").notNull().default("Active"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [index("vendor_devices_offering_idx").on(table.vendorOfferingId)]
);

export const vendorDeviceSlots = tapayoka.table(
  "vendor_device_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceWalletAddress: varchar("device_wallet_address", {
      length: 42,
    })
      .notNull()
      .references(() => vendorDevices.walletAddress, {
        onDelete: "cascade",
      }),
    label: varchar("label", { length: 255 }).notNull(),
    row: varchar("row", { length: 50 }),
    column: varchar("column", { length: 50 }),
    sortOrder: integer("sort_order").notNull().default(0),
    pricingTierId: varchar("pricing_tier_id", { length: 255 }),
    pricingTier: jsonb("pricing_tier"),
    // Per-slot relay behaviour (SlotAction) for multi-slot models.
    action: jsonb("action"),
    status: vendorEntityStatusEnum("status").notNull().default("Active"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [
    index("vendor_device_slots_device_idx").on(table.deviceWalletAddress),
    unique("vendor_device_slots_device_label_unique").on(
      table.deviceWalletAddress,
      table.label
    ),
  ]
);
