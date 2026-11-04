import { Hono } from "hono";
import { eq, desc, sql, and, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  orders,
  vendorDevices,
  vendorOfferings,
  vendorLocations,
  offerings,
} from "../../db/schema.ts";
import {
  successResponse,
  errorResponse,
  type OrderDetailed,
  type DashboardStats,
} from "@sudobility/tapayoka_types";
import type { AppEnv } from "../../lib/hono-types.ts";
import {
  getEntityWithPermission,
  getPermissionErrorStatus,
} from "../../lib/entity-helpers.ts";

const vendorOrders = new Hono<AppEnv>();

/**
 * Subquery of device wallet addresses owned by an entity.
 * Devices are entity-scoped indirectly:
 *   vendor_devices -> vendor_offerings -> vendor_locations.entity_id
 */
function entityDeviceWallets(db: ReturnType<typeof getDb>, entityId: string) {
  return db
    .select({ wallet: vendorDevices.walletAddress })
    .from(vendorDevices)
    .innerJoin(
      vendorOfferings,
      eq(vendorDevices.vendorOfferingId, vendorOfferings.id)
    )
    .innerJoin(
      vendorLocations,
      eq(vendorOfferings.vendorLocationId, vendorLocations.id)
    )
    .where(eq(vendorLocations.entityId, entityId));
}

/** GET / - List recent orders for entity */
vendorOrders.get("/", async c => {
  const limit = parseInt(c.req.query("limit") ?? "50");
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
      order: orders,
      deviceLabel: vendorDevices.label,
      offeringName: offerings.name,
      offeringType: offerings.type,
    })
    .from(orders)
    .innerJoin(
      vendorDevices,
      eq(orders.deviceWalletAddress, vendorDevices.walletAddress)
    )
    .innerJoin(
      vendorOfferings,
      eq(vendorDevices.vendorOfferingId, vendorOfferings.id)
    )
    .innerJoin(
      vendorLocations,
      eq(vendorOfferings.vendorLocationId, vendorLocations.id)
    )
    .innerJoin(offerings, eq(orders.offeringId, offerings.id))
    .where(eq(vendorLocations.entityId, result.entity.id))
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  const detailed: OrderDetailed[] = results.map(r => ({
    ...r.order,
    deviceLabel: r.deviceLabel,
    offeringName: r.offeringName,
    offeringType: r.offeringType,
  }));

  return c.json(successResponse(detailed));
});

/** GET /stats - Dashboard statistics for entity */
vendorOrders.get("/stats", async c => {
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
  const entityId = result.entity.id;

  // Orders belonging to this entity's devices.
  const ordersOfEntity = () =>
    inArray(orders.deviceWalletAddress, entityDeviceWallets(db, entityId));

  // Device (device) counts scoped to entity
  const [deviceCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(vendorDevices)
    .innerJoin(
      vendorOfferings,
      eq(vendorDevices.vendorOfferingId, vendorOfferings.id)
    )
    .innerJoin(
      vendorLocations,
      eq(vendorOfferings.vendorLocationId, vendorLocations.id)
    )
    .where(eq(vendorLocations.entityId, entityId));

  const [activeDeviceCount] = await db
    .select({ count: sql<number>`count(*)` })
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
        eq(vendorLocations.entityId, entityId),
        eq(vendorDevices.status, "Active")
      )
    );

  // Orders through entity's devices
  const [orderCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orders)
    .where(ordersOfEntity());

  const [activeOrderCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orders)
    .where(and(ordersOfEntity(), eq(orders.status, "RUNNING")));

  // Revenue today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [revenueToday] = await db
    .select({ total: sql<number>`COALESCE(SUM(${orders.amountCents}), 0)` })
    .from(orders)
    .where(
      and(
        ordersOfEntity(),
        eq(orders.status, "DONE"),
        gte(orders.createdAt, today)
      )
    );

  // Revenue this week
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [revenueWeek] = await db
    .select({ total: sql<number>`COALESCE(SUM(${orders.amountCents}), 0)` })
    .from(orders)
    .where(
      and(
        ordersOfEntity(),
        eq(orders.status, "DONE"),
        gte(orders.createdAt, weekAgo)
      )
    );

  // Success rate
  const [doneCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orders)
    .where(and(ordersOfEntity(), eq(orders.status, "DONE")));

  const [failedCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orders)
    .where(and(ordersOfEntity(), eq(orders.status, "FAILED")));

  const total = Number(doneCount?.count ?? 0) + Number(failedCount?.count ?? 0);
  const successRate = total > 0 ? Number(doneCount?.count ?? 0) / total : 1;

  const stats: DashboardStats = {
    totalDevices: Number(deviceCount?.count ?? 0),
    activeDevices: Number(activeDeviceCount?.count ?? 0),
    totalOrders: Number(orderCount?.count ?? 0),
    activeOrders: Number(activeOrderCount?.count ?? 0),
    revenueTodayCents: Number(revenueToday?.total ?? 0),
    revenueThisWeekCents: Number(revenueWeek?.total ?? 0),
    successRate: Math.round(successRate * 100) / 100,
  };

  return c.json(successResponse(stats));
});

export default vendorOrders;
