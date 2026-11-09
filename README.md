# tapayoka_api

Backend API server for Tapayoka, a QR-to-device cashless payment system. Buyers scan a
device QR, pay (Stripe), and receive a server-signed authorization that the device verifies
on-chain-style via ETH signatures; vendors manage their entities, devices, offerings, and
orders.

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [Hono](https://hono.dev)
- **Database**: PostgreSQL via [Drizzle ORM](https://orm.drizzle.team) (schema `tapayoka`)
- **Auth**: Firebase Admin SDK (ID-token verification)
- **Crypto**: ethers.js (server signs authorizations; verifies device signatures)
- **Payments**: Stripe
- **Validation**: Zod (+ `@hono/zod-validator`)

Shared code comes from private `@sudobility/*` packages (installed from GitHub Packages).

## Setup

```bash
bun install
cp .env.example .env     # then fill in real values (see below)
bun run db:migrate       # create schema + tables (idempotent; also runs on startup)
bun run dev              # dev server with hot reload (default http://localhost:3000)
```

Installing `@sudobility/*` packages requires GitHub Packages auth. `.npmrc` points
`@sudobility` at `https://npm.pkg.github.com`; provide a token with `read:packages`.

### Environment variables

Loaded from `.env`, `.env.local`, `.env.<NODE_ENV>`, `.env.<NODE_ENV>.local` by
`src/lib/env-helper.ts` (later files win), falling back to `process.env`.

- `DATABASE_URL` — PostgreSQL connection string (application only; tests never read it)
- `SERVER_ETH_PRIVATE_KEY` — server Ethereum private key for signing authorizations
- `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY`
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- `PORT` (default `3000`), `NODE_ENV`
- `TEST_DATABASE_URL` — used only by `bun run test:db`; must point at `localhost`

## Commands

```bash
bun run dev          # dev server, hot reload (port 3000)
bun run start        # run from source (src/index.ts)
bun run build        # bundle to dist/ (bun build, target bun)
bun run start:prod   # run the built bundle (dist/index.js)
bun run test:unit    # Vitest unit tests (no database; this is what CI runs)
bun run test:watch   # Vitest in watch mode
bun run test:db      # Vitest DB tests (*.db.test.ts); manual, needs TEST_DATABASE_URL
bun run typecheck    # tsc --noEmit
bun run lint         # ESLint over src
bun run format       # Prettier write over src
bun run db:migrate   # create/upgrade schema + tables (runs initDatabase())
```

There is no `bun run test` script; use `bun run test:unit`. `test:db` currently has no
`*.db.test.ts` files, so it exits non-zero with "No test files found" — expected.

## API routes

All mounted under `/api/v1`. There is also a top-level `GET /` and `GET /health` for
liveness.

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /api/v1/health` | None | Health check (name/version/status) |
| `/api/v1/buyer/devices` | None (public) | Verify device, list its offerings |
| `/api/v1/buyer/orders` | Firebase | Create order, pay, get status |
| `/api/v1/buyer/authorizations` | Firebase | Get server-signed authorization |
| `/api/v1/buyer/payment-methods` | Firebase | Manage buyer payment methods |
| `/api/v1/buyer/telemetry` | Firebase | Report device events |
| `/api/v1/me` | Firebase | Current user profile |
| `/api/v1/entities` | Firebase | Entity CRUD / membership |
| `/api/v1/invitations` | Firebase | Entity invitations |
| `/api/v1/device-setup` | Firebase + vendor | Server-signed `SETUP_SERVER` payload |
| `/api/v1/entities/:entitySlug/locations` | Firebase + vendor | Location CRUD |
| `/api/v1/entities/:entitySlug/models` | Firebase + vendor | Vendor model CRUD |
| `/api/v1/entities/:entitySlug/offerings` | Firebase + vendor | Offering CRUD |
| `/api/v1/entities/:entitySlug/devices` | Firebase + vendor | Device CRUD / assignment |
| `/api/v1/entities/:entitySlug/device-slots` | Firebase + vendor | Device slot config |
| `/api/v1/entities/:entitySlug/orders` | Firebase + vendor | Order monitoring / stats |
| `/api/v1/entities/:entitySlug/qr` | Firebase + vendor | QR code generation |

Vendor-scoped operations live under `/entities/:entitySlug/*` (entity-scoped), not a flat
`/vendor` prefix.

## Database

PostgreSQL schema `tapayoka`. `initDatabase()` (in `src/db/index.ts`) runs idempotent raw
`CREATE SCHEMA/TABLE IF NOT EXISTS` plus enum migrations on startup and via `bun run
db:migrate`. Main tables: `users`, `entities`, `entity_members`, `entity_invitations`,
`offerings`, `device_offerings`, `orders`, `authorizations`, `device_logs`, `admin_logs`,
`vendor_locations`, `vendor_models`, `vendor_offerings`, `vendor_devices`,
`vendor_device_slots`. (`entities`/`entity_members`/`entity_invitations` come from
`@sudobility/entity_service`.) `drizzle-kit` is available but schema creation is done by
raw SQL, not generated migrations.

## Deployment

CI/CD (`.github/workflows/ci-cd.yml`) delegates to the shared
`johnqh/workflows/.github/workflows/unified-cicd.yml`: tests on `main`/`develop`, builds the
`tapayoka_api` Docker image (`Dockerfile`, exposes `8025`) and deploys from `main`. NPM
publish is skipped (this is an app server, not a library).

## Related packages

- `@sudobility/tapayoka_types` — shared type definitions and response helpers
- `tapayoka_buyer_app_rn` — buyer mobile app
- `tapayoka_vendor_app` — vendor dashboard
- `tapayoka_pi` / `tapayoka_pi_pico` — device firmware

## License

BUSL-1.1
