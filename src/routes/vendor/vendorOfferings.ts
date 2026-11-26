import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, and, ne, inArray } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  vendorOfferings,
  vendorLocations,
  vendorModels,
  vendorDevices,
  vendorDeviceSlots,
} from "../../db/schema.ts";
import {
  vendorOfferingCreateSchema,
  vendorOfferingUpdateSchema,
  uuidSchema,
} from "../../schemas/index.ts";
import {
  successResponse,
  errorResponse,
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

const vendorOfferingsRoute = new Hono<AppEnv>();

/** GET /:id - Get a single vendor offering */
vendorOfferingsRoute.get("/:id", async c => {
  const id = c.req.param("id");
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    return c.json(errorResponse("Invalid offering ID"), 400);
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

  // Verify offering belongs to entity via location
  const [instResult] = await db
    .select({ offering: vendorOfferings })
    .from(vendorOfferings)
    .innerJoin(
      vendorLocations,
      eq(vendorOfferings.vendorLocationId, vendorLocations.id)
    )
    .where(
      and(
        eq(vendorOfferings.id, id),
        eq(vendorLocations.entityId, result.entity.id)
      )
    )
    .limit(1);

  if (!instResult) {
    return c.json(errorResponse("Offering not found"), 404);
  }

  const data: VendorOffering = {
    ...instResult.offering,
    pricingTiers: instResult.offering.pricingTiers as PricingTier[],
    schedule: instResult.offering.schedule as DailySchedule[] | null,
  };
  return c.json(successResponse(data));
});

/** POST / - Create a new vendor offering */
vendorOfferingsRoute.post(
  "/",
  zValidator("json", vendorOfferingCreateSchema),
  async c => {
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

    // Verify location belongs to entity
    const [location] = await db
      .select()
      .from(vendorLocations)
      .where(
        and(
          eq(vendorLocations.id, data.vendorLocationId),
          eq(vendorLocations.entityId, result.entity.id)
        )
      )
      .limit(1);

    if (!location) {
      return c.json(errorResponse("Location not found"), 404);
    }

    // Verify model belongs to entity
    const [model] = await db
      .select()
      .from(vendorModels)
      .where(
        and(
          eq(vendorModels.id, data.vendorModelId),
          eq(vendorModels.entityId, result.entity.id)
        )
      )
      .limit(1);

    if (!model) {
      return c.json(errorResponse("Model not found"), 404);
    }

    // Check unique constraint before insert
    const [existing] = await db
      .select()
      .from(vendorOfferings)
      .where(
        and(
          eq(vendorOfferings.vendorLocationId, data.vendorLocationId),
          eq(vendorOfferings.vendorModelId, data.vendorModelId)
        )
      )
      .limit(1);

    if (existing && existing.status !== "Deleted") {
      return c.json(
        errorResponse(
          "An offering already exists for this location and model combination"
        ),
        409
      );
    }

    let offering;
    if (existing) {
      // Reactivate soft-deleted offering
      const [reactivated] = await db
        .update(vendorOfferings)
        .set({ ...data, status: "Active" as const, updatedAt: new Date() })
        .where(eq(vendorOfferings.id, existing.id))
        .returning();
      offering = reactivated;
    } else {
      const [created] = await db
        .insert(vendorOfferings)
        .values(data)
        .returning();
      offering = created;
    }

    const responseData: VendorOffering = {
      ...offering,
      pricingTiers: offering.pricingTiers as PricingTier[],
      schedule: offering.schedule as DailySchedule[] | null,
    };
    return c.json(successResponse(responseData), 201);
  }
);

/** PUT /:id - Update a vendor offering */
vendorOfferingsRoute.put(
  "/:id",
  zValidator("json", vendorOfferingUpdateSchema),
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

    // Verify ownership via location join
    const [existing] = await db
      .select({ offering: vendorOfferings })
      .from(vendorOfferings)
      .innerJoin(
        vendorLocations,
        eq(vendorOfferings.vendorLocationId, vendorLocations.id)
      )
      .where(
        and(
          eq(vendorOfferings.id, id),
          eq(vendorLocations.entityId, result.entity.id)
        )
      )
      .limit(1);

    if (!existing) {
      return c.json(errorResponse("Offering not found"), 404);
    }

    // Don't let a tier be removed while a (Tiered) slot still references it by
    // id — that would leave the slot with a dangling price. The vendor must
    // re-point those slots first.
    if (data.pricingTiers) {
      const oldTiers = (existing.offering.pricingTiers as PricingTier[]) ?? [];
      const newIds = new Set(data.pricingTiers.map(t => t.id));
      const removedIds = oldTiers
        .map(t => t.id)
        .filter(tierId => !newIds.has(tierId));
      if (removedIds.length > 0) {
        const [referencing] = await db
          .select({ id: vendorDeviceSlots.id })
          .from(vendorDeviceSlots)
          .innerJoin(
            vendorDevices,
            eq(
              vendorDeviceSlots.deviceWalletAddress,
              vendorDevices.walletAddress
            )
          )
          .where(
            and(
              eq(vendorDevices.vendorOfferingId, id),
              ne(vendorDeviceSlots.status, "Deleted"),
              inArray(vendorDeviceSlots.pricingTierId, removedIds)
            )
          )
          .limit(1);
        if (referencing) {
          return c.json(
            errorResponse(
              "Cannot remove a pricing tier that a slot still uses; re-point those slots first"
            ),
            409
          );
        }
      }
    }

    const [updatedRow] = await db
      .update(vendorOfferings)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(vendorOfferings.id, id))
      .returning();

    const updated: VendorOffering = {
      ...updatedRow,
      pricingTiers: updatedRow.pricingTiers as PricingTier[],
      schedule: updatedRow.schedule as DailySchedule[] | null,
    };
    return c.json(successResponse(updated));
  }
);

/** DELETE /:id - Delete a vendor offering (409 if has devices; controls cascade) */
vendorOfferingsRoute.delete("/:id", async c => {
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

  // Verify ownership via location join
  const [existing] = await db
    .select({ offering: vendorOfferings })
    .from(vendorOfferings)
    .innerJoin(
      vendorLocations,
      eq(vendorOfferings.vendorLocationId, vendorLocations.id)
    )
    .where(
      and(
        eq(vendorOfferings.id, id),
        eq(vendorLocations.entityId, result.entity.id)
      )
    )
    .limit(1);

  if (!existing) {
    return c.json(errorResponse("Offering not found"), 404);
  }

  await db
    .update(vendorOfferings)
    .set({ status: "Deleted" as const, updatedAt: new Date() })
    .where(eq(vendorOfferings.id, id));
  const data: DeleteResult = { deleted: true };
  return c.json(successResponse(data));
});

export default vendorOfferingsRoute;
