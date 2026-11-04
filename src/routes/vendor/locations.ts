import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, ne, and, sql } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  vendorLocations,
  vendorOfferings,
  vendorModels,
  vendorDevices,
} from "../../db/schema.ts";
import {
  vendorLocationCreateSchema,
  vendorLocationUpdateSchema,
  uuidSchema,
} from "../../schemas/index.ts";
import {
  successResponse,
  errorResponse,
  type VendorLocation,
  type VendorOffering,
  type PricingTier,
  type DailySchedule,
  type DeleteResult,
} from "@sudobility/tapayoka_types";
import type { AppEnv } from "../../lib/hono-types.ts";
import {
  getEntityWithPermission,
  getPermissionErrorStatus,
} from "../../lib/entity-helpers.ts";

const locations = new Hono<AppEnv>();

/** GET / - List all locations for the entity */
locations.get("/", async c => {
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
      location: vendorLocations,
      offeringCount: sql<number>`count(${vendorOfferings.id})::int`,
    })
    .from(vendorLocations)
    .leftJoin(
      vendorOfferings,
      and(
        eq(vendorOfferings.vendorLocationId, vendorLocations.id),
        ne(vendorOfferings.status, "Deleted")
      )
    )
    .where(
      and(
        eq(vendorLocations.entityId, result.entity.id),
        ne(vendorLocations.status, "Deleted")
      )
    )
    .groupBy(vendorLocations.id);
  const data: VendorLocation[] = results.map(r => ({
    ...r.location,
    offeringCount: r.offeringCount,
  }));
  return c.json(successResponse(data));
});

/** GET /:id - Get a single location */
locations.get("/:id", async c => {
  const id = c.req.param("id");
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    return c.json(errorResponse("Invalid location ID"), 400);
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
  const [location] = await db
    .select()
    .from(vendorLocations)
    .where(eq(vendorLocations.id, id))
    .limit(1);

  if (!location || location.entityId !== result.entity.id) {
    return c.json(errorResponse("Location not found"), 404);
  }

  const data: VendorLocation = location;
  return c.json(successResponse(data));
});

/** POST / - Create a new location */
locations.post("/", zValidator("json", vendorLocationCreateSchema), async c => {
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
  const [created] = await db
    .insert(vendorLocations)
    .values({ ...data, entityId: result.entity.id })
    .returning();

  const location: VendorLocation = created;
  return c.json(successResponse(location), 201);
});

/** PUT /:id - Update a location */
locations.put(
  "/:id",
  zValidator("json", vendorLocationUpdateSchema),
  async c => {
    const id = c.req.param("id");
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
    const [location] = await db
      .select()
      .from(vendorLocations)
      .where(eq(vendorLocations.id, id))
      .limit(1);

    if (!location || location.entityId !== result.entity.id) {
      return c.json(errorResponse("Location not found"), 404);
    }

    const [updatedRow] = await db
      .update(vendorLocations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(vendorLocations.id, id))
      .returning();

    const updated: VendorLocation = updatedRow;
    return c.json(successResponse(updated));
  }
);

/** DELETE /:id - Delete a location (409 if has offerings) */
locations.delete("/:id", async c => {
  const id = c.req.param("id");
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
  const [location] = await db
    .select()
    .from(vendorLocations)
    .where(eq(vendorLocations.id, id))
    .limit(1);

  if (!location || location.entityId !== result.entity.id) {
    return c.json(errorResponse("Location not found"), 404);
  }

  await db
    .update(vendorLocations)
    .set({ status: "Deleted" as const, updatedAt: new Date() })
    .where(eq(vendorLocations.id, id));
  const data: DeleteResult = { deleted: true };
  return c.json(successResponse(data));
});

/** GET /:id/offerings - Get offerings for a location */
locations.get("/:id/offerings", async c => {
  const id = c.req.param("id");
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
  const [location] = await db
    .select()
    .from(vendorLocations)
    .where(eq(vendorLocations.id, id))
    .limit(1);

  if (!location || location.entityId !== result.entity.id) {
    return c.json(errorResponse("Location not found"), 404);
  }

  const results = await db
    .select({
      offering: vendorOfferings,
      modelName: vendorModels.name,
      deviceCount: sql<number>`count(${vendorDevices.walletAddress})::int`,
    })
    .from(vendorOfferings)
    .innerJoin(vendorModels, eq(vendorOfferings.vendorModelId, vendorModels.id))
    .leftJoin(
      vendorDevices,
      and(
        eq(vendorDevices.vendorOfferingId, vendorOfferings.id),
        ne(vendorDevices.status, "Deleted")
      )
    )
    .where(
      and(
        eq(vendorOfferings.vendorLocationId, id),
        ne(vendorOfferings.status, "Deleted")
      )
    )
    .groupBy(vendorOfferings.id, vendorModels.name);

  const data: VendorOffering[] = results.map(r => ({
    ...r.offering,
    pricingTiers: r.offering.pricingTiers as PricingTier[],
    schedule: r.offering.schedule as DailySchedule[] | null,
    modelName: r.modelName,
    deviceCount: r.deviceCount,
  }));
  return c.json(successResponse(data));
});

export default locations;
