import { Hono } from "hono";
import { firebaseAuth } from "../middleware/firebaseAuth.ts";
import { roleGuard } from "../middleware/roleGuard.ts";
import type { AppEnv } from "../lib/hono-types.ts";

// Public routes
import health from "./public/health.ts";

// Buyer routes
import buyerDevices from "./buyer/devices.ts";
import buyerOrders from "./buyer/orders.ts";
import buyerAuthorizations from "./buyer/authorizations.ts";
import buyerPaymentMethods from "./buyer/paymentMethods.ts";
import telemetry from "./buyer/telemetry.ts";

// Entity/vendor routes
import entitiesRouter from "./entities.ts";
import invitationsRouter from "./invitations.ts";
import meRouter from "./me.ts";
import vendorOrders from "./vendor/orders.ts";
import vendorQr from "./vendor/qr.ts";
import vendorLocations from "./vendor/locations.ts";
import vendorModels from "./vendor/models.ts";
import vendorOfferings from "./vendor/vendorOfferings.ts";
import vendorDevices from "./vendor/devices.ts";
import vendorDeviceSlots from "./vendor/deviceSlots.ts";
import deviceSetup from "./vendor/deviceSetup.ts";

const routes = new Hono();

// --- Public routes (no auth) ---
routes.route("/health", health);

// --- Public buyer routes (no auth) ---
routes.route("/buyer/devices", buyerDevices);

// --- Buyer routes (Firebase auth) ---
const buyerRoutes = new Hono<AppEnv>();
buyerRoutes.use("*", firebaseAuth);
buyerRoutes.route("/orders", buyerOrders);
buyerRoutes.route("/authorizations", buyerAuthorizations);
buyerRoutes.route("/payment-methods", buyerPaymentMethods);
buyerRoutes.route("/telemetry", telemetry);
routes.route("/buyer", buyerRoutes);

// --- Authenticated routes (Firebase auth required) ---
const authRoutes = new Hono<AppEnv>();
authRoutes.use("*", firebaseAuth);

// User profile
authRoutes.route("/me", meRouter);

// Entity management (any authenticated user)
authRoutes.route("/entities", entitiesRouter);

// Invitation management (any authenticated user)
authRoutes.route("/invitations", invitationsRouter);

// Device provisioning: server-signed SETUP_SERVER payload (vendor role)
authRoutes.use("/device-setup/*", roleGuard("vendor"));
authRoutes.route("/device-setup", deviceSetup);

// Entity-scoped vendor routes (require vendor role)
const vendorEntityRoutes = new Hono<AppEnv>();
vendorEntityRoutes.use("*", roleGuard("vendor"));
vendorEntityRoutes.route("/locations", vendorLocations);
vendorEntityRoutes.route("/models", vendorModels);
vendorEntityRoutes.route("/offerings", vendorOfferings);
vendorEntityRoutes.route("/devices", vendorDevices);
vendorEntityRoutes.route("/device-slots", vendorDeviceSlots);
vendorEntityRoutes.route("/orders", vendorOrders);
vendorEntityRoutes.route("/qr", vendorQr);

authRoutes.route("/entities/:entitySlug", vendorEntityRoutes);

routes.route("/", authRoutes);

export default routes;
