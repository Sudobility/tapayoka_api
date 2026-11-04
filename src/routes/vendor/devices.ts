import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, and, count, ne } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  vendorDevices,
  vendorDeviceSlots,
  vendorOfferings,
  vendorLocations,
  vendorModels,
} from "../../db/schema.ts";
import {
  vendorDeviceCreateSchema,
  vendorDeviceUpdateSchema,
  ethAddressSchema,
  uuidSchema,
} from "../../schemas/index.ts";
import {
  successResponse,
  errorResponse,
  verifySignedData,
  type VendorDevice,
  type VendorDeviceLookup,
  type DeleteResult,
} from "@sudobility/tapayoka_types";
import type { AppEnv } from "../../lib/hono-types.ts";
import {
  getEntityWithPermission,
  getPermissionErrorStatus,
} from "../../lib/entity-helpers.ts";
import { verifyResponseSignature } from "../../services/crypto.ts";

const devices = new Hono<AppEnv>();

/** Helper: verify offering belongs to entity via location */
async function verifyOfferingOwnership(
  db: ReturnType<typeof getDb>,
  offeringId: string,
  entityId: string
) {
  const [result] = await db
    .select({ offering: vendorOfferings })
    .from(vendorOfferings)
    .innerJoin(
      vendorLocations,
      eq(vendorOfferings.vendorLocationId, vendorLocations.id)
    )
    .where(
      and(
        eq(vendorOfferings.id, offeringId),
        eq(vendorLocations.entityId, entityId)
      )
    )
    .limit(1);
  return !!result;
}

/** GET / - Get all devices for the entity (org-wide), enriched for display.
 *  Powers the Devices tab's flat list so each device shows its location/model
 *  without the client fetching per offering. */
devices.get("/", async c => {
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
  const results = await db
    .select({
      walletAddress: vendorDevices.walletAddress,
      vendorOfferingId: vendorDevices.vendorOfferingId,
      label: vendorDevices.label,
      connectionString: vendorDevices.connectionString,
      status: vendorDevices.status,
      createdAt: vendorDevices.createdAt,
      updatedAt: vendorDevices.updatedAt,
      slotCount: count(vendorDeviceSlots.id),
      offeringName: vendorOfferings.name,
      locationId: vendorLocations.id,
      locationName: vendorLocations.name,
      modelId: vendorModels.id,
      modelName: vendorModels.name,
      modelType: vendorModels.type,
    })
    .from(vendorDevices)
    .innerJoin(
      vendorOfferings,
      eq(vendorDevices.vendorOfferingId, vendorOfferings.id)
    )
    .innerJoin(
      vendorLocations,
      eq(vendorOfferings.vendorLocationId, vendorLocations.id)
    )
    .innerJoin(vendorModels, eq(vendorOfferings.vendorModelId, vendorModels.id))
    .leftJoin(
      vendorDeviceSlots,
      eq(vendorDevices.walletAddress, vendorDeviceSlots.deviceWalletAddress)
    )
    .where(
      and(
        eq(vendorLocations.entityId, result.entity.id),
        ne(vendorDevices.status, "Deleted")
      )
    )
    // Group by the four primary keys; the selected name/type columns are
    // functionally dependent on them, which Postgres allows.
    .groupBy(
      vendorDevices.walletAddress,
      vendorOfferings.id,
      vendorLocations.id,
      vendorModels.id
    );

  const data: VendorDevice[] = results;
  return c.json(successResponse(data));
});

/** GET /service/:serviceId - Get all devices for an offering */
devices.get("/service/:serviceId", async c => {
  const serviceId = c.req.param("serviceId");
  const parsed = uuidSchema.safeParse(serviceId);
  if (!parsed.success) {
    return c.json(errorResponse("Invalid service ID"), 400);
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
  const owned = await verifyOfferingOwnership(db, serviceId, result.entity.id);
  if (!owned) {
    return c.json(errorResponse("Offering not found"), 404);
  }

  const results = await db
    .select({
      walletAddress: vendorDevices.walletAddress,
      vendorOfferingId: vendorDevices.vendorOfferingId,
      label: vendorDevices.label,
      connectionString: vendorDevices.connectionString,
      status: vendorDevices.status,
      createdAt: vendorDevices.createdAt,
      updatedAt: vendorDevices.updatedAt,
      slotCount: count(vendorDeviceSlots.id),
    })
    .from(vendorDevices)
    .leftJoin(
      vendorDeviceSlots,
      eq(vendorDevices.walletAddress, vendorDeviceSlots.deviceWalletAddress)
    )
    .where(
      and(
        eq(vendorDevices.vendorOfferingId, serviceId),
        ne(vendorDevices.status, "Deleted")
      )
    )
    .groupBy(vendorDevices.walletAddress);

  const data: VendorDevice[] = results;
  return c.json(successResponse(data));
});

/** GET /lookup/:walletAddress - Ownership-aware existence check for a scanned
 *  device, so the add-device flow can fail fast (and with the right message)
 *  before running the wizard. Returns `available` (free to add), `owned` (this
 *  entity already has it — with its offering, for navigation), or `taken`
 *  (another entity owns it; no identifying details are returned). */
devices.get("/lookup/:walletAddress", async c => {
  const walletAddress = c.req.param("walletAddress");
  const parsedAddr = ethAddressSchema.safeParse(walletAddress);
  if (!parsedAddr.success) {
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
  const [row] = await db
    .select({
      label: vendorDevices.label,
      offeringId: vendorDevices.vendorOfferingId,
      entityId: vendorLocations.entityId,
    })
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
        ne(vendorDevices.status, "Deleted")
      )
    )
    .limit(1);

  let data: VendorDeviceLookup;
  if (!row) {
    data = { walletAddress, status: "available" };
  } else if (row.entityId === result.entity.id) {
    data = {
      walletAddress,
      status: "owned",
      offeringId: row.offeringId,
      label: row.label,
    };
  } else {
    data = { walletAddress, status: "taken" };
  }
  return c.json(successResponse(data));
});

/** POST / - Create a new device */
devices.post("/", zValidator("json", vendorDeviceCreateSchema), async c => {
  const body = c.req.valid("json");
  const entitySlug = c.req.param("entitySlug");
  const userId = c.get("firebaseUid");

  // Verify device proof (data integrity + signature)
  // Allow 5 minutes for the user to fill the device form after scanning
  if (!verifySignedData(body.deviceProof, 5 * 60 * 1000)) {
    return c.json(errorResponse("Device signing data mismatch"), 400);
  }

  if (!verifyResponseSignature(body.deviceProof.signing)) {
    return c.json(errorResponse("Invalid device signature"), 401);
  }

  // Verify walletAddress in data matches signing walletAddress
  if (
    body.deviceProof.data.walletAddress !==
    body.deviceProof.signing.walletAddress
  ) {
    return c.json(errorResponse("Wallet address mismatch"), 400);
  }

  const walletAddress = body.deviceProof.data.walletAddress;

  const result = await getEntityWithPermission(entitySlug, userId, true);
  if (result.error !== undefined) {
    return c.json(
      { ...errorResponse(result.error), errorCode: result.errorCode },
      getPermissionErrorStatus(result.errorCode)
    );
  }

  const db = getDb();
  const owned = await verifyOfferingOwnership(
    db,
    body.vendorOfferingId,
    result.entity.id
  );
  if (!owned) {
    return c.json(errorResponse("Offering not found"), 404);
  }

  // Check for existing wallet address
  const [existing] = await db
    .select()
    .from(vendorDevices)
    .where(eq(vendorDevices.walletAddress, walletAddress))
    .limit(1);

  if (existing && existing.status !== "Deleted") {
    return c.json(
      errorResponse("Device with this wallet address already exists"),
      409
    );
  }

  const deviceData = {
    walletAddress,
    vendorOfferingId: body.vendorOfferingId,
    label: body.label,
    connectionString: body.connectionString ?? null,
  };

  let device;
  if (existing) {
    // Reactivate soft-deleted device
    const [reactivated] = await db
      .update(vendorDevices)
      .set({
        ...deviceData,
        status: "Active" as const,
        updatedAt: new Date(),
      })
      .where(eq(vendorDevices.walletAddress, walletAddress))
      .returning();
    device = reactivated;
  } else {
    const [created] = await db
      .insert(vendorDevices)
      .values(deviceData)
      .returning();
    device = created;
  }

  // Auto-create slot for single-slot models
  const [offering] = await db
    .select({ modelSlot: vendorModels.slot })
    .from(vendorOfferings)
    .innerJoin(vendorModels, eq(vendorOfferings.vendorModelId, vendorModels.id))
    .where(eq(vendorOfferings.id, body.vendorOfferingId))
    .limit(1);

  if (
    offering &&
    (offering.modelSlot === "single" || offering.modelSlot === null)
  ) {
    // Reactivate soft-deleted slot or create new one
    const [existingSlot] = await db
      .select()
      .from(vendorDeviceSlots)
      .where(
        and(
          eq(vendorDeviceSlots.deviceWalletAddress, walletAddress),
          eq(vendorDeviceSlots.label, body.label)
        )
      )
      .limit(1);

    if (existingSlot) {
      await db
        .update(vendorDeviceSlots)
        .set({ status: "Active" as const, updatedAt: new Date() })
        .where(eq(vendorDeviceSlots.id, existingSlot.id));
    } else {
      await db.insert(vendorDeviceSlots).values({
        deviceWalletAddress: walletAddress,
        label: body.label,
        sortOrder: 0,
      });
    }
  }

  const data: VendorDevice = device;
  return c.json(successResponse(data), 201);
});

/** PUT /:walletAddress - Update an device */
devices.put(
  "/:walletAddress",
  zValidator("json", vendorDeviceUpdateSchema),
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

    // Get device and verify ownership through offering -> location
    const [device] = await db
      .select()
      .from(vendorDevices)
      .where(eq(vendorDevices.walletAddress, walletAddress))
      .limit(1);

    if (!device) {
      return c.json(errorResponse("Device not found"), 404);
    }

    const owned = await verifyOfferingOwnership(
      db,
      device.vendorOfferingId,
      result.entity.id
    );
    if (!owned) {
      return c.json(errorResponse("Device not found"), 404);
    }

    // If changing vendorOfferingId, verify ownership of target offering too
    if (data.vendorOfferingId) {
      const targetOwned = await verifyOfferingOwnership(
        db,
        data.vendorOfferingId,
        result.entity.id
      );
      if (!targetOwned) {
        return c.json(errorResponse("Target offering not found"), 404);
      }
    }

    const [updatedRow] = await db
      .update(vendorDevices)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(vendorDevices.walletAddress, walletAddress))
      .returning();

    const updated: VendorDevice = updatedRow;
    return c.json(successResponse(updated));
  }
);

/** DELETE /:walletAddress - Delete an device */
devices.delete("/:walletAddress", async c => {
  const walletAddress = c.req.param("walletAddress");
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
  const [device] = await db
    .select()
    .from(vendorDevices)
    .where(eq(vendorDevices.walletAddress, walletAddress))
    .limit(1);

  if (!device) {
    return c.json(errorResponse("Device not found"), 404);
  }

  const owned = await verifyOfferingOwnership(
    db,
    device.vendorOfferingId,
    result.entity.id
  );
  if (!owned) {
    return c.json(errorResponse("Device not found"), 404);
  }

  await db
    .update(vendorDevices)
    .set({ status: "Deleted" as const, updatedAt: new Date() })
    .where(eq(vendorDevices.walletAddress, walletAddress));
  const data: DeleteResult = { deleted: true };
  return c.json(successResponse(data));
});

export default devices;
