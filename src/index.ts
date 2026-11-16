/**
 * @fileoverview Tapayoka API entry point
 * @description Hono app setup with CORS, logging, health check, and route mounting.
 * Initializes the database on startup and exports the Bun server configuration.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { initDatabase } from "./db/index.ts";
import routes from "./routes/index.ts";
import {
  successResponse,
  type ApiInfoResponse,
  type HealthCheckData,
} from "@sudobility/types";
import { getEnv } from "./lib/env-helper.ts";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Request/response body logging
app.use("/api/*", async (c, next) => {
  if (c.req.method === "POST" || c.req.method === "PUT") {
    const body = await c.req.json().catch(() => null);
    if (body) {
      console.log(
        `[API →] ${c.req.method} ${c.req.path}`,
        JSON.stringify(body)
      );
      // Re-inject body so downstream handlers can read it
      c.req.raw = new Request(c.req.raw, { body: JSON.stringify(body) });
    }
  }
  await next();
  const contentType = c.res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const resBody = await c.res
      .clone()
      .json()
      .catch(() => null);
    if (resBody) {
      console.log(
        `[API ←] ${c.req.method} ${c.req.path}`,
        JSON.stringify(resBody)
      );
    }
  }
});

// Root API metadata
app.get("/", c => {
  const info: ApiInfoResponse = {
    name: "Tapayoka API",
    version: "0.0.1",
    status: "healthy",
  };
  return c.json(successResponse(info));
});

// Health endpoint (public, no auth)
app.get("/health", c => {
  const health: HealthCheckData = {
    status: "healthy",
    version: "0.0.1",
  };
  return c.json(successResponse(health));
});

// API routes
app.route("/api/v1", routes);

// Initialize database and start server
const port = parseInt(getEnv("PORT", "3000")!);

initDatabase()
  .then(() => {
    console.log(`Tapayoka API running on http://localhost:${port}`);
  })
  .catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });

export default {
  port,
  fetch: app.fetch,
};

// Export app for testing
export { app };
