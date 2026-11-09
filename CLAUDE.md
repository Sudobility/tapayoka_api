# tapayoka_api

> **Git policy — never auto-commit or auto-push.** Leave your work in the working tree.
> Run `git commit`, `git push`, or `gh pr create` **only when the user explicitly asks in
> that turn**. Approval for an earlier change does not carry forward, and finishing a task
> is not permission to commit it. Stay on the current branch; do not create feature branches.

Backend API for the Tapayoka QR-to-device cashless payment system. Hono + Bun + Drizzle +
PostgreSQL.

## Stack

- **Runtime**: Bun (entry `src/index.ts`, exports `{ port, fetch }` for Bun.serve)
- **Framework**: Hono
- **Database**: PostgreSQL + Drizzle ORM, schema `tapayoka`
- **Auth**: Firebase Admin SDK (ID-token verification)
- **Crypto**: ethers.js (server signs authorizations, verifies device signatures)
- **Payments**: Stripe
- **Validation**: Zod
- Shared code from private `@sudobility/*` packages (GitHub Packages; needs `read:packages`)

## Commands

```bash
bun install          # install deps
bun run dev          # dev server, hot reload (default port 3000)
bun run start        # run from src; start:prod runs built dist/index.js
bun run build        # bundle to dist/ (target bun)
bun run test:unit    # unit tests (vitest run). No DB. THIS is what CI runs.
bun run test:watch   # vitest watch
bun run test:db      # DB tests (*.db.test.ts), MANUAL, never in CI.
                     #   Needs TEST_DATABASE_URL at localhost. No *.db.test.ts files
                     #   exist yet, so it exits non-zero ("No test files found") — expected.
bun run typecheck    # tsc --noEmit
bun run lint         # eslint src
bun run format       # prettier --write src
bun run db:migrate   # runs initDatabase(): idempotent CREATE ... IF NOT EXISTS + enum migs
```

There is **no `test` script** — `bun run test` fails. Use `bun run test:unit`.

## Architecture

- `src/index.ts` — Hono app: logger, CORS, API request/response body logging, top-level
  `GET /` + `GET /health`, mounts routes at `/api/v1`, calls `initDatabase()` on startup.
- `src/routes/index.ts` — central route tree (read this first to see auth layering).
- `src/middleware/firebaseAuth.ts` — verifies Firebase token, auto-creates user record.
- `src/middleware/roleGuard.ts` — enforces `vendor`/`buyer` role separation.
- `src/services/` — `crypto` (ETH sign/verify), `authorizationPayload`, `firebase`,
  `stripe`, `resolveTier`.
- `src/db/index.ts` — Drizzle client + `initDatabase()` (raw SQL schema creation).
  `src/db/schema.ts` — table/enum definitions.

### Route auth layering (actual, non-obvious)

- Public (no auth): `/api/v1/health`, **`/api/v1/buyer/devices`** (public, despite being
  under /buyer).
- Firebase auth: `/api/v1/buyer/{orders,authorizations,payment-methods,telemetry}`,
  `/api/v1/me`, `/api/v1/entities`, `/api/v1/invitations`.
- Firebase + `vendor` role: `/api/v1/device-setup` and everything under
  **`/api/v1/entities/:entitySlug/*`** (`locations`, `models`, `offerings`, `devices`,
  `device-slots`, `orders`, `qr`). There is **no flat `/vendor/*` prefix** — vendor ops are
  entity-scoped.

## Database

Schema `tapayoka`; created idempotently by `initDatabase()` (raw `CREATE ... IF NOT EXISTS`
+ enum migrations) on startup and via `db:migrate`, not by drizzle-kit migrations. Tables:
`users`, `entities`, `entity_members`, `entity_invitations`, `offerings`,
`device_offerings`, `orders`, `authorizations`, `device_logs`, `admin_logs`,
`vendor_locations`, `vendor_models`, `vendor_offerings`, `vendor_devices`,
`vendor_device_slots`. `entities*` tables come from `@sudobility/entity_service`.

## Environment

Loaded by `src/lib/env-helper.ts` from `.env` → `.env.local` → `.env.<NODE_ENV>` →
`.env.<NODE_ENV>.local` (later wins), then `process.env`. Use `getEnv` / `getRequiredEnv`,
not `process.env` directly.

- `DATABASE_URL` — app only. Tests never read it: `tests/setup.ts` deletes it, so a prod URL
  in your shell cannot reach a test.
- `TEST_DATABASE_URL` — `test:db` only. Must be exactly `localhost`; the guard refuses any
  other host, `127.0.0.1` included.
- `SERVER_ETH_PRIVATE_KEY`, `STRIPE_SECRET_KEY`, `FIREBASE_PROJECT_ID`,
  `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `PORT` (default 3000).

## Gotchas

- Default port is 3000 locally; the Docker image exposes/health-checks `8025` (set via
  `PORT`).
- `bunfig.toml` was removed deliberately (its `[test] preload` was dead config — tests use
  vitest, not `bun test`). Don't reintroduce it.
- CI uses the shared reusable workflow `johnqh/workflows/.../unified-cicd.yml`; NPM publish
  is skipped (app server, not a library).
