import { Hono } from "hono";
import { buildServerSetupPayload } from "../../services/crypto.ts";
import { successResponse, errorResponse } from "@sudobility/types";
import type { AppEnv } from "../../lib/hono-types.ts";

const deviceSetup = new Hono<AppEnv>();

/**
 * GET /server-wallet - Server-signed SETUP_SERVER payload.
 *
 * The vendor app forwards this to a device (over BLE/WS) so the device can
 * store the server's wallet address and later verify EXECUTE commands.
 */
deviceSetup.get("/server-wallet", async c => {
  try {
    const payload = await buildServerSetupPayload();
    return c.json(successResponse(payload));
  } catch (error: any) {
    return c.json(
      errorResponse(error?.message ?? "Failed to build server setup payload"),
      500
    );
  }
});

export default deviceSetup;
