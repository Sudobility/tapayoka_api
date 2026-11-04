import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  vendorDevices,
  vendorOfferings,
  vendorLocations,
} from "../../db/schema.ts";
import { ethAddressSchema } from "../../schemas/index.ts";
import {
  successResponse,
  errorResponse,
  type QrCodeResponse,
} from "@sudobility/tapayoka_types";
import type { AppEnv } from "../../lib/hono-types.ts";
import {
  getEntityWithPermission,
  getPermissionErrorStatus,
} from "../../lib/entity-helpers.ts";

const vendorQr = new Hono<AppEnv>();

/** GET /:walletAddress - Generate QR code data for a device */
vendorQr.get("/:walletAddress", async c => {
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
  const [device] = await db
    .select({ walletAddress: vendorDevices.walletAddress })
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
        eq(vendorLocations.entityId, result.entity.id)
      )
    )
    .limit(1);

  if (!device) {
    return c.json(errorResponse("Device not found"), 404);
  }

  const qrResponse: QrCodeResponse = {
    deviceWalletAddress: walletAddress,
    qrData: walletAddress,
    format: "svg",
  };

  return c.json(successResponse(qrResponse));
});

export default vendorQr;
