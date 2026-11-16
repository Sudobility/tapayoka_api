import { Hono } from "hono";
import { successResponse, type HealthCheckData } from "@sudobility/types";
import pkg from "../../../package.json";

const health = new Hono();

health.get("/", c => {
  const data: HealthCheckData = {
    version: pkg.version,
    status: "healthy",
  };
  return c.json(successResponse(data));
});

export default health;
