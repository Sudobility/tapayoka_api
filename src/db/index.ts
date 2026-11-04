import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";
import { getRequiredEnv } from "../lib/env-helper.ts";
import { runEntityMigration } from "@sudobility/entity_service";

// Lazy-initialized database connection
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sql: ReturnType<typeof postgres> | null = null;

function getConnection() {
  if (!sql) {
    const databaseUrl = getRequiredEnv("DATABASE_URL");
    sql = postgres(databaseUrl);
  }
  return sql;
}

/** Get the Drizzle database instance (lazy init) */
export function getDb() {
  if (!db) {
    db = drizzle(getConnection(), { schema });
  }
  return db;
}

/** Get raw SQL connection for migrations */
export function getSql() {
  return getConnection();
}

/** Initialize database: create schema and run migrations */
export async function initDatabase() {
  const connection = getConnection();

  // Create schema if not exists
  await connection`CREATE SCHEMA IF NOT EXISTS tapayoka`;

  // --- Installation → Device rename (preserve data on existing DBs) ---
  // Run BEFORE the CREATE TABLE IF NOT EXISTS statements below so existing rows
  // are renamed in place rather than orphaned behind a fresh empty table. Each
  // is idempotent: ALTER ... IF EXISTS no-ops on a fresh DB or a second run.
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE IF EXISTS tapayoka.vendor_installations RENAME TO vendor_devices; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE IF EXISTS tapayoka.vendor_installation_slots RENAME TO vendor_device_slots; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.vendor_device_slots RENAME COLUMN installation_wallet_address TO device_wallet_address; EXCEPTION WHEN undefined_column OR undefined_table OR duplicate_column THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER INDEX IF EXISTS tapayoka.vendor_installations_offering_idx RENAME TO vendor_devices_offering_idx; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER INDEX IF EXISTS tapayoka.vendor_installation_slots_installation_idx RENAME TO vendor_device_slots_device_idx; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);
  // Normalize the vendor_devices → vendor_offerings FK name carried over from the
  // old table name, so it matches what the create path below expects.
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.vendor_devices RENAME CONSTRAINT vendor_installations_vendor_offering_id_fkey TO vendor_devices_vendor_offering_id_fkey; EXCEPTION WHEN undefined_object OR undefined_table OR duplicate_object THEN NULL; END $$;
  `);

  // Create enums
  const enumDefs = [
    {
      name: "tapayoka.offering_type",
      values: ["TRIGGER", "FIXED", "TIMED"],
    },
    {
      name: "tapayoka.order_status",
      values: ["CREATED", "PAID", "AUTHORIZED", "RUNNING", "DONE", "FAILED"],
    },
    { name: "tapayoka.user_role", values: ["vendor", "buyer"] },
    {
      name: "tapayoka.log_direction",
      values: ["PI_TO_SRV", "SRV_TO_PI"],
    },
    {
      name: "tapayoka.vendor_model_type",
      values: [
        "Washer",
        "Dryer",
        "Parking",
        "Charging",
        "Locker",
        "Vending",
        "Tourist Binocular",
      ],
    },
  ];

  for (const { name, values } of enumDefs) {
    const valuesStr = values.map(v => `'${v}'`).join(", ");
    await connection.unsafe(
      `DO $$ BEGIN CREATE TYPE ${name} AS ENUM (${valuesStr}); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
    );
  }

  // Create users table
  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      firebase_uid VARCHAR(128) NOT NULL UNIQUE,
      email VARCHAR(255),
      display_name VARCHAR(255),
      role tapayoka.user_role NOT NULL DEFAULT 'buyer',
      tos_accepted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Add tos_accepted_at column if it doesn't exist (migration for existing DBs)
  await connection`
    ALTER TABLE tapayoka.users ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMP
  `;

  // Run entity_service migrations (creates entities, entity_members, entity_invitations tables)
  await runEntityMigration({
    client: connection,
    schemaName: "tapayoka",
    indexPrefix: "tapayoka",
    migrateProjects: false,
    migrateUsers: false,
  });

  // Create legacy tables (offerings uses entity_id FK)
  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.offerings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id UUID NOT NULL REFERENCES tapayoka.entities(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      type tapayoka.offering_type NOT NULL,
      price_cents INTEGER NOT NULL,
      fixed_minutes INTEGER,
      minutes_per_25c INTEGER,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.device_offerings (
      device_wallet_address VARCHAR(42) NOT NULL,
      offering_id UUID NOT NULL REFERENCES tapayoka.offerings(id) ON DELETE CASCADE,
      UNIQUE(device_wallet_address, offering_id)
    )
  `;

  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_wallet_address VARCHAR(42) NOT NULL,
      offering_id UUID NOT NULL REFERENCES tapayoka.offerings(id),
      buyer_uid VARCHAR(128),
      amount_cents INTEGER NOT NULL,
      authorized_seconds INTEGER NOT NULL DEFAULT 0,
      status tapayoka.order_status NOT NULL DEFAULT 'CREATED',
      stripe_payment_intent_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.authorizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL UNIQUE REFERENCES tapayoka.orders(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL,
      server_signature TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.device_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_wallet_address VARCHAR(42) NOT NULL,
      direction tapayoka.log_direction NOT NULL,
      ok BOOLEAN NOT NULL DEFAULT true,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.admin_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(128) NOT NULL,
      action VARCHAR(255) NOT NULL,
      entity_type VARCHAR(100),
      entity_id VARCHAR(255),
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // --- Vendor Management Tables (entity-scoped) ---
  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.vendor_locations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id UUID NOT NULL REFERENCES tapayoka.entities(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      address VARCHAR(255) NOT NULL,
      city VARCHAR(255) NOT NULL,
      state_province VARCHAR(255) NOT NULL,
      zipcode VARCHAR(20) NOT NULL,
      country VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.vendor_models (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id UUID NOT NULL REFERENCES tapayoka.entities(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      type tapayoka.vendor_model_type,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.vendor_offerings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vendor_location_id UUID NOT NULL REFERENCES tapayoka.vendor_locations(id),
      vendor_model_id UUID NOT NULL REFERENCES tapayoka.vendor_models(id),
      name VARCHAR(255) NOT NULL,
      pricing JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(vendor_location_id, vendor_model_id)
    )
  `;

  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.vendor_devices (
      wallet_address VARCHAR(42) PRIMARY KEY NOT NULL,
      vendor_offering_id UUID NOT NULL REFERENCES tapayoka.vendor_offerings(id),
      label VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // --- Migrations for existing databases ---
  // Rename enums
  await connection.unsafe(`
    DO $$ BEGIN ALTER TYPE tapayoka.service_type RENAME TO offering_type; EXCEPTION WHEN undefined_object OR duplicate_object THEN NULL; END $$;
  `);

  // Rename VARIABLE → TIMED in offering_type enum
  await connection.unsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VARIABLE' AND enumtypid = 'tapayoka.offering_type'::regtype) THEN
        ALTER TYPE tapayoka.offering_type RENAME VALUE 'VARIABLE' TO 'TIMED';
      END IF;
    EXCEPTION WHEN undefined_object THEN NULL;
    END $$;
  `);

  // Rename legacy tables
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE IF EXISTS tapayoka.services RENAME TO offerings; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE IF EXISTS tapayoka.device_services RENAME TO device_offerings; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);

  // Rename legacy columns
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.device_offerings RENAME COLUMN service_id TO offering_id; EXCEPTION WHEN undefined_column THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.orders RENAME COLUMN service_id TO offering_id; EXCEPTION WHEN undefined_column OR duplicate_column THEN NULL; END $$;
  `);
  // Legacy orders column device_id → offering_id (equipment→device→offering churn)
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.orders RENAME COLUMN device_id TO offering_id; EXCEPTION WHEN undefined_column OR duplicate_column THEN NULL; END $$;
  `);

  // Rename vendor tables
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE IF EXISTS tapayoka.vendor_equipment_categories RENAME TO vendor_models; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE IF EXISTS tapayoka.vendor_services RENAME TO vendor_offerings; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE IF EXISTS tapayoka.vendor_service_controls RENAME TO vendor_offering_controls; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);

  // Rename vendor_equipments → vendor_devices
  // Drop stale vendor_devices if it has the wrong schema (leftover from previous renames)
  await connection.unsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'tapayoka' AND table_name = 'vendor_devices' AND column_name = 'id')
         AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'tapayoka' AND table_name = 'vendor_equipments') THEN
        DROP TABLE tapayoka.vendor_devices CASCADE;
      END IF;
    END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE IF EXISTS tapayoka.vendor_equipments RENAME TO vendor_devices; EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);

  // Add type column to vendor_models (nullable)
  await connection`ALTER TABLE tapayoka.vendor_models ADD COLUMN IF NOT EXISTS type tapayoka.vendor_model_type`;

  // Add newer vendor_model_type values to existing databases (idempotent).
  await connection.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'Charging' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'vendor_model_type' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'tapayoka'))) THEN
        ALTER TYPE tapayoka.vendor_model_type ADD VALUE 'Charging';
      END IF;
    END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'Tourist Binocular' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'vendor_model_type' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'tapayoka'))) THEN
        ALTER TYPE tapayoka.vendor_model_type ADD VALUE 'Tourist Binocular';
      END IF;
    END $$;
  `);

  // Add enums and columns to vendor_models
  // Recreate pricing enum if it has old values (variableAtStart/variableAtEnd → timed)
  await connection.unsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'variableAtStart' AND enumtypid = 'tapayoka.vendor_model_pricing'::regtype) THEN
        ALTER TABLE tapayoka.vendor_models DROP COLUMN IF EXISTS pricing;
        DROP TYPE tapayoka.vendor_model_pricing;
      END IF;
    EXCEPTION WHEN undefined_object THEN NULL;
    END $$;
  `);
  // Rename 'variable' → 'timed' in vendor_model_pricing enum
  await connection.unsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'variable' AND enumtypid = 'tapayoka.vendor_model_pricing'::regtype) THEN
        UPDATE tapayoka.vendor_models SET pricing = NULL WHERE pricing = 'variable';
        ALTER TABLE tapayoka.vendor_models DROP COLUMN IF EXISTS pricing;
        DROP TYPE tapayoka.vendor_model_pricing;
      END IF;
    EXCEPTION WHEN undefined_object THEN NULL;
    END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN CREATE TYPE tapayoka.vendor_model_pricing AS ENUM ('fixed', 'timed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN CREATE TYPE tapayoka.vendor_model_action AS ENUM ('timed', 'sequence'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN CREATE TYPE tapayoka.vendor_model_interruption AS ENUM ('stop', 'continue'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN CREATE TYPE tapayoka.vendor_model_payment AS ENUM ('atStart', 'atEnd'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await connection`ALTER TABLE tapayoka.vendor_models ADD COLUMN IF NOT EXISTS pricing tapayoka.vendor_model_pricing`;
  await connection`ALTER TABLE tapayoka.vendor_models ADD COLUMN IF NOT EXISTS action tapayoka.vendor_model_action`;
  await connection`ALTER TABLE tapayoka.vendor_models ADD COLUMN IF NOT EXISTS interruption tapayoka.vendor_model_interruption`;
  await connection`ALTER TABLE tapayoka.vendor_models ADD COLUMN IF NOT EXISTS payment tapayoka.vendor_model_payment`;
  await connection`ALTER TABLE tapayoka.vendor_models ADD COLUMN IF NOT EXISTS schedule JSONB`;

  // Rename vendor columns
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.vendor_offerings RENAME COLUMN vendor_equipment_category_id TO vendor_model_id; EXCEPTION WHEN undefined_column THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.vendor_offering_controls RENAME COLUMN vendor_service_id TO vendor_offering_id; EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.vendor_devices RENAME COLUMN vendor_service_id TO vendor_offering_id; EXCEPTION WHEN undefined_column THEN NULL; END $$;
  `);
  // Rename device columns to offering columns (device→offering rename)
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.vendor_devices RENAME COLUMN vendor_device_id TO vendor_offering_id; EXCEPTION WHEN undefined_column THEN NULL; END $$;
  `);
  // Rename equipment columns to offering columns (equipment→device rename)
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.vendor_devices RENAME COLUMN vendor_equipment_id TO vendor_offering_id; EXCEPTION WHEN undefined_column THEN NULL; END $$;
  `);

  // Fix stale FK: vendor_equipments_vendor_service_id_fkey still points at vendor_services
  await connection.unsafe(`
    DO $$ BEGIN
      ALTER TABLE tapayoka.vendor_devices DROP CONSTRAINT IF EXISTS vendor_equipments_vendor_service_id_fkey;
      ALTER TABLE tapayoka.vendor_devices DROP CONSTRAINT IF EXISTS vendor_equipments_vendor_offering_id_fkey;
      ALTER TABLE tapayoka.vendor_devices
        ADD CONSTRAINT vendor_devices_vendor_offering_id_fkey
        FOREIGN KEY (vendor_offering_id) REFERENCES tapayoka.vendor_offerings(id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // Rename vendor_devices.name → label
  await connection.unsafe(`
    DO $$ BEGIN ALTER TABLE tapayoka.vendor_devices RENAME COLUMN name TO label; EXCEPTION WHEN undefined_column THEN NULL; END $$;
  `);

  // Add slot enum + column to vendor_models
  await connection.unsafe(`
    DO $$ BEGIN CREATE TYPE tapayoka.vendor_model_slot AS ENUM ('single', 'multi'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await connection`ALTER TABLE tapayoka.vendor_models ADD COLUMN IF NOT EXISTS slot tapayoka.vendor_model_slot`;

  // Migrate vendor_model_slot enum: add multi1D, multi2D, migrate multi -> multi1D, remove multi
  await connection.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'multi1D' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'vendor_model_slot' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'tapayoka'))) THEN
        ALTER TYPE tapayoka.vendor_model_slot ADD VALUE 'multi1D';
      END IF;
    END $$;
  `);
  await connection.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'multi2D' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'vendor_model_slot' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'tapayoka'))) THEN
        ALTER TYPE tapayoka.vendor_model_slot ADD VALUE 'multi2D';
      END IF;
    END $$;
  `);
  // Migrate existing 'multi' values to 'multi1D'
  await connection.unsafe(`
    UPDATE tapayoka.vendor_models SET slot = 'multi1D' WHERE slot = 'multi';
  `);

  // Add slot_pricing enum + column to vendor_models
  await connection.unsafe(`
    DO $$ BEGIN CREATE TYPE tapayoka.vendor_model_slot_pricing AS ENUM ('Same', 'Different'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await connection`ALTER TABLE tapayoka.vendor_models ADD COLUMN IF NOT EXISTS slot_pricing tapayoka.vendor_model_slot_pricing`;

  // Add Tiered to slot_pricing enum
  await connection.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'Tiered' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'vendor_model_slot_pricing' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'tapayoka'))) THEN
        ALTER TYPE tapayoka.vendor_model_slot_pricing ADD VALUE 'Tiered';
      END IF;
    END $$;
  `);

  // Add 'Unique' to slot_pricing enum and migrate old values
  await connection.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'Unique' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'vendor_model_slot_pricing' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'tapayoka'))) THEN
        ALTER TYPE tapayoka.vendor_model_slot_pricing ADD VALUE 'Unique';
      END IF;
    END $$;
  `);
  await connection.unsafe(`
    UPDATE tapayoka.vendor_models SET slot_pricing = 'Unique' WHERE slot_pricing IN ('Same', 'Different');
  `);

  // Migrate vendor_offerings.pricing → pricing_tiers (JSONB array of PricingTier)
  await connection.unsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'tapayoka' AND table_name = 'vendor_offerings' AND column_name = 'pricing' AND data_type = 'jsonb') THEN
        ALTER TABLE tapayoka.vendor_offerings ADD COLUMN IF NOT EXISTS pricing_tiers JSONB;
        UPDATE tapayoka.vendor_offerings SET pricing_tiers = CASE
          WHEN pricing->>'type' = 'multi' THEN (
            SELECT jsonb_agg(
              jsonb_set(
                jsonb_set(s->'pricing', '{id}', to_jsonb(gen_random_uuid()::text)),
                '{name}', s->'name'
              )
            )
            FROM jsonb_array_elements(pricing->'slots') AS s
          )
          ELSE jsonb_build_array(
            pricing || jsonb_build_object('id', gen_random_uuid()::text, 'name', 'Default')
          )
        END WHERE pricing_tiers IS NULL;
        ALTER TABLE tapayoka.vendor_offerings ALTER COLUMN pricing_tiers SET NOT NULL;
        ALTER TABLE tapayoka.vendor_offerings DROP COLUMN pricing;
      END IF;
    END $$;
  `);

  // Create vendor_device_slots table
  await connection`
    CREATE TABLE IF NOT EXISTS tapayoka.vendor_device_slots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_wallet_address VARCHAR(42) NOT NULL REFERENCES tapayoka.vendor_devices(wallet_address) ON DELETE CASCADE,
      label VARCHAR(255) NOT NULL,
      "row" VARCHAR(50),
      "column" VARCHAR(50),
      sort_order INTEGER NOT NULL DEFAULT 0,
      pricing_tier_id VARCHAR(255),
      pricing_tier JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(device_wallet_address, label)
    )
  `;
  await connection`CREATE INDEX IF NOT EXISTS vendor_device_slots_device_idx ON tapayoka.vendor_device_slots(device_wallet_address)`;

  // Add slot_id column to orders (references vendor_device_slots)
  await connection`ALTER TABLE tapayoka.orders ADD COLUMN IF NOT EXISTS slot_id UUID REFERENCES tapayoka.vendor_device_slots(id) ON DELETE SET NULL`;

  // Per-slot relay behaviour (SlotAction) for multi-slot models. No backfill
  // needed: single-slot models keep the action on the tier, and the API derives
  // a SlotAction from a tier's legacy pinNumber/signals when this is null.
  await connection`ALTER TABLE tapayoka.vendor_device_slots ADD COLUMN IF NOT EXISTS action JSONB`;

  // Add pricing_tier_id and pricing_tier columns to vendor_devices
  await connection`ALTER TABLE tapayoka.vendor_devices ADD COLUMN IF NOT EXISTS pricing_tier_id VARCHAR(255)`;
  await connection`ALTER TABLE tapayoka.vendor_devices ADD COLUMN IF NOT EXISTS pricing_tier JSONB`;

  // Migrate vendor_offerings: add pricing JSONB, migrate existing data, drop old columns
  await connection.unsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'tapayoka' AND table_name = 'vendor_offerings' AND column_name = 'price') THEN
        ALTER TABLE tapayoka.vendor_offerings ADD COLUMN IF NOT EXISTS pricing JSONB;
        UPDATE tapayoka.vendor_offerings vi SET pricing = jsonb_build_object(
          'type', 'fixed',
          'currencyCode', vi.currency_code,
          'price', vi.price::text,
          'signals', COALESCE(
            (SELECT jsonb_agg(jsonb_build_object('pinNumber', vic.pin_number, 'duration', vic.duration))
             FROM tapayoka.vendor_offering_controls vic WHERE vic.vendor_offering_id = vi.id),
            '[]'::jsonb
          )
        ) WHERE vi.pricing IS NULL;
        ALTER TABLE tapayoka.vendor_offerings ALTER COLUMN pricing SET NOT NULL;
        ALTER TABLE tapayoka.vendor_offerings DROP COLUMN IF EXISTS price;
        ALTER TABLE tapayoka.vendor_offerings DROP COLUMN IF EXISTS currency_code;
      END IF;
    END $$;
  `);

  // --- Vendor entity status enum + status columns ---
  await connection.unsafe(`
    DO $$ BEGIN CREATE TYPE tapayoka.vendor_entity_status AS ENUM ('Active', 'Inactive', 'Deleted'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await connection`ALTER TABLE tapayoka.vendor_locations ADD COLUMN IF NOT EXISTS status tapayoka.vendor_entity_status NOT NULL DEFAULT 'Active'`;
  await connection`ALTER TABLE tapayoka.vendor_models ADD COLUMN IF NOT EXISTS status tapayoka.vendor_entity_status NOT NULL DEFAULT 'Active'`;
  await connection`ALTER TABLE tapayoka.vendor_offerings ADD COLUMN IF NOT EXISTS status tapayoka.vendor_entity_status NOT NULL DEFAULT 'Active'`;
  await connection`ALTER TABLE tapayoka.vendor_devices ADD COLUMN IF NOT EXISTS status tapayoka.vendor_entity_status NOT NULL DEFAULT 'Active'`;
  await connection`ALTER TABLE tapayoka.vendor_device_slots ADD COLUMN IF NOT EXISTS status tapayoka.vendor_entity_status NOT NULL DEFAULT 'Active'`;

  // --- Move schedule from vendor_models to vendor_offerings ---
  await connection`ALTER TABLE tapayoka.vendor_offerings ADD COLUMN IF NOT EXISTS schedule JSONB`;
  // Migrate schedule data: copy from model to each offering that references it
  await connection.unsafe(`
    UPDATE tapayoka.vendor_offerings vo
    SET schedule = (SELECT schedule FROM tapayoka.vendor_models vm WHERE vm.id = vo.vendor_model_id)
    WHERE vo.schedule IS NULL
      AND EXISTS (SELECT 1 FROM tapayoka.vendor_models vm WHERE vm.id = vo.vendor_model_id AND vm.schedule IS NOT NULL)
  `);
  await connection.unsafe(`
    ALTER TABLE tapayoka.vendor_models DROP COLUMN IF EXISTS schedule
  `);

  // --- Single-slot migration: auto-create slot for single-slot devices without slots ---
  await connection.unsafe(`
    INSERT INTO tapayoka.vendor_device_slots (device_wallet_address, label, sort_order, pricing_tier_id, pricing_tier)
    SELECT vi.wallet_address, vi.label, 0, vi.pricing_tier_id, vi.pricing_tier
    FROM tapayoka.vendor_devices vi
    JOIN tapayoka.vendor_offerings vo ON vo.id = vi.vendor_offering_id
    JOIN tapayoka.vendor_models vm ON vm.id = vo.vendor_model_id
    WHERE (vm.slot = 'single' OR vm.slot IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM tapayoka.vendor_device_slots vis
        WHERE vis.device_wallet_address = vi.wallet_address
      )
  `);

  // Drop pricing columns from vendor_devices (now lives on slots)
  await connection.unsafe(
    `ALTER TABLE tapayoka.vendor_devices DROP COLUMN IF EXISTS pricing_tier_id`
  );
  await connection.unsafe(
    `ALTER TABLE tapayoka.vendor_devices DROP COLUMN IF EXISTS pricing_tier`
  );

  // Add connection_string to vendor_devices
  await connection`ALTER TABLE tapayoka.vendor_devices ADD COLUMN IF NOT EXISTS connection_string TEXT`;

  // Rename vendor_model_pricing 'timed' → 'variable'
  await connection.unsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'timed' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'vendor_model_pricing' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'tapayoka'))) THEN
        ALTER TYPE tapayoka.vendor_model_pricing RENAME VALUE 'timed' TO 'variable';
      END IF;
    END $$;
  `);

  // Add pricing_tier_id to orders, make offering_id nullable
  await connection`ALTER TABLE tapayoka.orders ADD COLUMN IF NOT EXISTS pricing_tier_id VARCHAR(255)`;
  await connection.unsafe(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'tapayoka' AND table_name = 'orders' AND column_name = 'offering_id' AND is_nullable = 'NO'
      ) THEN
        ALTER TABLE tapayoka.orders ALTER COLUMN offering_id DROP NOT NULL;
      END IF;
    END $$;
  `);

  // Add stripe_customer_id to users
  await connection`ALTER TABLE tapayoka.users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)`;

  // Repoint device_wallet_address FKs from the legacy (empty) devices table to
  // vendor_devices — the table the app actually provisions and validates
  // against. DROP IF EXISTS + ADD makes this idempotent across restarts.
  await connection`ALTER TABLE tapayoka.orders DROP CONSTRAINT IF EXISTS orders_device_wallet_address_fkey`;
  await connection`ALTER TABLE tapayoka.orders ADD CONSTRAINT orders_device_wallet_address_fkey FOREIGN KEY (device_wallet_address) REFERENCES tapayoka.vendor_devices(wallet_address)`;
  await connection`ALTER TABLE tapayoka.device_logs DROP CONSTRAINT IF EXISTS device_logs_device_wallet_address_fkey`;
  await connection`ALTER TABLE tapayoka.device_logs ADD CONSTRAINT device_logs_device_wallet_address_fkey FOREIGN KEY (device_wallet_address) REFERENCES tapayoka.vendor_devices(wallet_address)`;
  await connection`ALTER TABLE tapayoka.device_offerings DROP CONSTRAINT IF EXISTS device_offerings_device_wallet_address_fkey`;
  await connection`ALTER TABLE tapayoka.device_offerings ADD CONSTRAINT device_offerings_device_wallet_address_fkey FOREIGN KEY (device_wallet_address) REFERENCES tapayoka.vendor_devices(wallet_address) ON DELETE CASCADE`;

  // --- Drop orphan legacy tables (leftovers from service→device→offering renames) ---
  // First drop the stale FK on the live orders table that still points at the legacy
  // "services" table (carried over from the old service_id column); otherwise DROP fails.
  await connection`ALTER TABLE tapayoka.orders DROP CONSTRAINT IF EXISTS orders_service_id_fkey`;
  // CASCADE clears the remaining inter-orphan FKs.
  await connection`DROP TABLE IF EXISTS tapayoka.device_devices CASCADE`;
  await connection`DROP TABLE IF EXISTS tapayoka.device_services CASCADE`;
  await connection`DROP TABLE IF EXISTS tapayoka.vendor_device_controls CASCADE`;
  await connection`DROP TABLE IF EXISTS tapayoka.vendor_offering_controls CASCADE`;
  await connection`DROP TABLE IF EXISTS tapayoka.vendor_service_controls CASCADE`;
  await connection`DROP TABLE IF EXISTS tapayoka.vendor_services CASCADE`;
  await connection`DROP TABLE IF EXISTS tapayoka.vendor_equipment_categories CASCADE`;
  await connection`DROP TABLE IF EXISTS tapayoka.devices CASCADE`;
  await connection`DROP TABLE IF EXISTS tapayoka.services CASCADE`;

  // Retire the legacy entity-scoped devices table (superseded by vendor_devices).
  // Its incoming FKs (orders/device_logs/device_offerings) were repointed above.
  await connection`DROP TABLE IF EXISTS tapayoka.devices CASCADE`;
  await connection.unsafe(
    `DO $$ BEGIN DROP TYPE tapayoka.device_status; EXCEPTION WHEN undefined_object OR dependent_objects_still_exist THEN NULL; END $$;`
  );

  // Create indexes
  await connection`CREATE INDEX IF NOT EXISTS offerings_entity_idx ON tapayoka.offerings(entity_id)`;
  await connection`CREATE INDEX IF NOT EXISTS orders_device_idx ON tapayoka.orders(device_wallet_address)`;
  await connection`CREATE INDEX IF NOT EXISTS orders_status_idx ON tapayoka.orders(status)`;
  await connection`CREATE INDEX IF NOT EXISTS authorizations_order_idx ON tapayoka.authorizations(order_id)`;
  await connection`CREATE INDEX IF NOT EXISTS device_logs_device_idx ON tapayoka.device_logs(device_wallet_address)`;
  await connection`CREATE INDEX IF NOT EXISTS admin_logs_user_idx ON tapayoka.admin_logs(user_id)`;
  await connection`CREATE INDEX IF NOT EXISTS vendor_locations_entity_idx ON tapayoka.vendor_locations(entity_id)`;
  await connection`CREATE INDEX IF NOT EXISTS vendor_models_entity_idx ON tapayoka.vendor_models(entity_id)`;
  await connection`CREATE INDEX IF NOT EXISTS vendor_offerings_location_idx ON tapayoka.vendor_offerings(vendor_location_id)`;
  await connection`CREATE INDEX IF NOT EXISTS vendor_offerings_model_idx ON tapayoka.vendor_offerings(vendor_model_id)`;
  await connection`CREATE INDEX IF NOT EXISTS vendor_devices_offering_idx ON tapayoka.vendor_devices(vendor_offering_id)`;

  console.log("Database initialized successfully");
}
