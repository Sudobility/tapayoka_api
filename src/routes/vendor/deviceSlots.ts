import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  vendorDeviceSlots,
  vendorDevices,
  vendorOfferings,
  vendorLocations,
} from "../../db/schema.ts";
import {
  vendorDeviceSlotCreateSchema,
  vendorDeviceSlotUpdateSchema,
  vendorDeviceSlotBulkCreateSchema,
  ethAddressSchema,
  uuidSchema,
} from "../../schemas/index.ts";
import {
  successResponse,
  errorResponse,
  type VendorDeviceSlot,
  type PricingTier,
  type SlotAction,
  type DeleteResult,
} from "@sudobility/tapayoka_types";
import type { AppEnv } from "../../lib/hono-types.ts";
import {
  getEntityWithPermission,
  getPermissionErrorStatus,
} from "../../lib/entity-helpers.ts";

const deviceSlots = new Hono<AppEnv>();

/** Helper: verify device belongs to entity via offering -> location */
async function verifyDeviceOwnership(
  db: ReturnType<typeof getDb>,
  walletAddress: string,
  entityId: string
) {
  const [result] = await db
    .select({ device: vendorDevices })
    .from(vendorDevices)
    .innerJoin(
      vendorOfferings,
      eq(vendorDevices.vendorOfferingId, vendorOfferings.id)
    )
    .innerJoin(
      vendorLocations,
      eq(vendorOfferings.vendorLocationId, vendorLocations.id)
    )
    .where(
      and(
        eq(vendorDevices.walletAddress, walletAddress),
        eq(vendorLocations.entityId, entityId)
      )
    )
    .limit(1);
  return !!result;
}

/** GET /device/:walletAddress - List all slots for an device */
deviceSlots.get("/device/:walletAddress", async c => {
  const walletAddress = c.req.param("walletAddress");
  const parsed = ethAddressSchema.safeParse(walletAddress);
  if (!parsed.success) {
    return c.json(errorResponse("Invalid wallet address"), 400);
  }

  const entitySlug = c.req.param("entitySlug");
  const userId = c.get("firebaseUid");

  const result = await getEntityWithPermission(entitySlug, userId);
  if (result.error !== undefined) {
    return c.json(
      { ...errorResponse(result.error), errorCode: result.errorCode },
      getPermissionErrorStatus(result.errorCode)
    );
  }

  const db = getDb();
  const owned = await verifyDeviceOwnership(
    db,
    walletAddress,
    result.entity.id
  );
  if (!owned) {
    return c.json(errorResponse("Device not found"), 404);
  }

  const results = await db
    .select()
    .from(vendorDeviceSlots)
    .where(eq(vendorDeviceSlots.deviceWalletAddress, walletAddress))
    .orderBy(vendorDeviceSlots.sortOrder);

  const data: VendorDeviceSlot[] = results.map(r => ({
    ...r,
    pricingTier: r.pricingTier as PricingTier | null,
    action: r.action as SlotAction | null,
  }));
  return c.json(successResponse(data));
});

/** POST /device/:walletAddress - Create a single slot */
deviceSlots.post(
  "/device/:walletAddress",
  zValidator("json", vendorDeviceSlotCreateSchema),
  async c => {
    const walletAddress = c.req.param("walletAddress");
    const parsedAddr = ethAddressSchema.safeParse(walletAddress);
    if (!parsedAddr.success) {
      return c.json(errorResponse("Invalid wallet address"), 400);
    }

    const data = c.req.valid("json");
    const entitySlug = c.req.param("entitySlug");
    const userId = c.get("firebaseUid");

    const result = await getEntityWithPermission(entitySlug, userId, true);
    if (result.error !== undefined) {
      return c.json(
        { ...errorResponse(result.error), errorCode: result.errorCode },
        getPermissionErrorStatus(result.errorCode)
      );
    }

    const db = getDb();
    const owned = await verifyDeviceOwnership(
      db,
      walletAddress,
      result.entity.id
    );
    if (!owned) {
      return c.json(errorResponse("Device not found"), 404);
    }

    // Check for soft-deleted slot with same label
    const [existingSlot] = await db
      .select()
      .from(vendorDeviceSlots)
      .where(
        and(
          eq(vendorDeviceSlots.deviceWalletAddress, walletAddress),
          eq(vendorDeviceSlots.label, data.label)
        )
      )
      .limit(1);

    let slot;
    if (existingSlot && existingSlot.status === "Deleted") {
      const [reactivated] = await db
        .update(vendorDeviceSlots)
        .set({
          ...data,
          deviceWalletAddress: walletAddress,
          status: "Active" as const,
          updatedAt: new Date(),
        })
        .where(eq(vendorDeviceSlots.id, existingSlot.id))
        .returning();
      slot = reactivated;
    } else if (existingSlot) {
      return c.json(
        errorResponse("A slot with this label already exists"),
        409
      );
    } else {
      const [created] = await db
        .insert(vendorDeviceSlots)
        .values({
          deviceWalletAddress: walletAddress,
          ...data,
        })
        .returning();
      slot = created;
    }

    const responseData: VendorDeviceSlot = {
      ...slot,
      pricingTier: slot.pricingTier as PricingTier | null,
      action: slot.action as SlotAction | null,
    };
    return c.json(successResponse(responseData), 201);
  }
);

/** POST /device/:walletAddress/bulk - Bulk create from rows x columns */
deviceSlots.post(
  "/device/:walletAddress/bulk",
  zValidator("json", vendorDeviceSlotBulkCreateSchema),
  async c => {
    const walletAddress = c.req.param("walletAddress");
    const parsedAddr = ethAddressSchema.safeParse(walletAddress);
    if (!parsedAddr.success) {
      return c.json(errorResponse("Invalid wallet address"), 400);
    }

    const data = c.req.valid("json");
    const entitySlug = c.req.param("entitySlug");
    const userId = c.get("firebaseUid");

    const result = await getEntityWithPermission(entitySlug, userId, true);
    if (result.error !== undefined) {
      return c.json(
        { ...errorResponse(result.error), errorCode: result.errorCode },
        getPermissionErrorStatus(result.errorCode)
      );
    }

    const db = getDb();
    const owned = await verifyDeviceOwnership(
      db,
      walletAddress,
      result.entity.id
    );
    if (!owned) {
      return c.json(errorResponse("Device not found"), 404);
    }

    // Generate labels row-major: A1, A2, ..., B1, B2, ...
    const values = data.rows.flatMap((row, rowIdx) =>
      data.columns.map((col, colIdx) => ({
        deviceWalletAddress: walletAddress,
        label: `${row}${col}`,
        row,
        column: col,
        sortOrder: rowIdx * data.columns.length + colIdx,
      }))
    );

    const slots = await db
      .insert(vendorDeviceSlots)
      .values(values)
      .onConflictDoUpdate({
        target: [
          vendorDeviceSlots.deviceWalletAddress,
          vendorDeviceSlots.label,
        ],
        set: {
          row: sql`excluded.row`,
          column: sql`excluded.column`,
          sortOrder: sql`excluded.sort_order`,
          status: "Active" as const,
          updatedAt: new Date(),
        },
      })
      .returning();

    const responseData: VendorDeviceSlot[] = slots.map(s => ({
      ...s,
      pricingTier: s.pricingTier as PricingTier | null,
      action: s.action as SlotAction | null,
    }));
    return c.json(successResponse(responseData), 201);
  }
);

/** PUT /:slotId - Update a slot */
deviceSlots.put(
  "/:slotId",
  zValidator("json", vendorDeviceSlotUpdateSchema),
  async c => {
    const slotId = c.req.param("slotId");
    const parsedId = uuidSchema.safeParse(slotId);
    if (!parsedId.success) {
      return c.json(errorResponse("Invalid slot ID"), 400);
    }

    const data = c.req.valid("json");
    const entitySlug = c.req.param("entitySlug");
    const userId = c.get("firebaseUid");

    const result = await getEntityWithPermission(entitySlug, userId, true);
    if (result.error !== undefined) {
      return c.json(
        { ...errorResponse(result.error), errorCode: result.errorCode },
        getPermissionErrorStatus(result.errorCode)
      );
    }

    const db = getDb();

    // Get slot and verify ownership
    const [slot] = await db
      .select()
      .from(vendorDeviceSlots)
      .where(eq(vendorDeviceSlots.id, slotId))
      .limit(1);

    if (!slot) {
      return c.json(errorResponse("Slot not found"), 404);
    }

    const owned = await verifyDeviceOwnership(
      db,
      slot.deviceWalletAddress,
      result.entity.id
    );
    if (!owned) {
      return c.json(errorResponse("Slot not found"), 404);
    }

    const [updatedRow] = await db
      .update(vendorDeviceSlots)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(vendorDeviceSlots.id, slotId))
      .returning();

    const updated: VendorDeviceSlot = {
      ...updatedRow,
      pricingTier: updatedRow.pricingTier as PricingTier | null,
      action: updatedRow.action as SlotAction | null,
    };
    return c.json(successResponse(updated));
  }
);

/** DELETE /:slotId - Delete a slot */
deviceSlots.delete("/:slotId", async c => {
  const slotId = c.req.param("slotId");
  const parsedId = uuidSchema.safeParse(slotId);
  if (!parsedId.success) {
    return c.json(errorResponse("Invalid slot ID"), 400);
  }

  const entitySlug = c.req.param("entitySlug");
  const userId = c.get("firebaseUid");

  const result = await getEntityWithPermission(entitySlug, userId, true);
  if (result.error !== undefined) {
    return c.json(
      { ...errorResponse(result.error), errorCode: result.errorCode },
      getPermissionErrorStatus(result.errorCode)
    );
  }

  const db = getDb();
  const [slot] = await db
    .select()
    .from(vendorDeviceSlots)
    .where(eq(vendorDeviceSlots.id, slotId))
    .limit(1);

  if (!slot) {
    return c.json(errorResponse("Slot not found"), 404);
  }

  const owned = await verifyDeviceOwnership(
    db,
    slot.deviceWalletAddress,
    result.entity.id
  );
  if (!owned) {
    return c.json(errorResponse("Slot not found"), 404);
  }

  await db
    .update(vendorDeviceSlots)
    .set({ status: "Deleted" as const, updatedAt: new Date() })
    .where(eq(vendorDeviceSlots.id, slotId));
  const deleteData: DeleteResult = { deleted: true };
  return c.json(successResponse(deleteData));
});

/** DELETE /device/:walletAddress - Delete all slots for an device */
deviceSlots.delete("/device/:walletAddress", async c => {
  const walletAddress = c.req.param("walletAddress");
  const parsedAddr = ethAddressSchema.safeParse(walletAddress);
  if (!parsedAddr.success) {
    return c.json(errorResponse("Invalid wallet address"), 400);
  }

  const entitySlug = c.req.param("entitySlug");
  const userId = c.get("firebaseUid");

  const result = await getEntityWithPermission(entitySlug, userId, true);
  if (result.error !== undefined) {
    return c.json(
      { ...errorResponse(result.error), errorCode: result.errorCode },
      getPermissionErrorStatus(result.errorCode)
    );
  }

  const db = getDb();
  const owned = await verifyDeviceOwnership(
    db,
    walletAddress,
    result.entity.id
  );
  if (!owned) {
    return c.json(errorResponse("Device not found"), 404);
  }

  await db
    .update(vendorDeviceSlots)
    .set({ status: "Deleted" as const, updatedAt: new Date() })
    .where(eq(vendorDeviceSlots.deviceWalletAddress, walletAddress));
  const deleteData: DeleteResult = { deleted: true };
  return c.json(successResponse(deleteData));
});

export default deviceSlots;
