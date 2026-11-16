import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../../db/index.ts";
import { deviceLogs } from "../../db/schema.ts";
import { telemetryEventSchema } from "../../schemas/index.ts";
import { successResponse } from "@sudobility/types";
import { type DeviceLog } from "@sudobility/tapayoka_types";

const telemetry = new Hono();

/**
 * POST / - Log a device telemetry event
 */
telemetry.post("/", zValidator("json", telemetryEventSchema), async c => {
  const data = c.req.valid("json");

  const db = getDb();
  const [logRow] = await db.insert(deviceLogs).values(data).returning();

  const log: DeviceLog = logRow;
  return c.json(successResponse(log), 201);
});

export default telemetry;
