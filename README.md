# YeaStay

Hotel, restaurant and bar platform for a three-property group in Kenya: **K1 Klubhouse** (Parklands, HQ), **Small World Country Club** (Lukenya) and **Kahama Mombasa**, under one legal entity and one KRA PIN. The development brief v1.2 is the source of truth; requirement IDs below refer to it.

This repository currently holds the **foundation**: monorepo, database schema and guards, API core, SAP integration worker with a Service Layer mock, back-office and PWA shells, and Docker Compose stacks. See [docs/requirements-traceability.md](docs/requirements-traceability.md) for exactly which requirement IDs are done, partial or not started.

![Back office](docs/screenshots/overview.png)

## Layout

| Path | What |
|---|---|
| `apps/api` | NestJS API (TypeScript, PostgreSQL, Redis/BullMQ). SQL migrations in `apps/api/migrations`. |
| `apps/backoffice` | React back office / reception shell (Vite). |
| `apps/pwa` | PWA shell for waiter tablets and housekeeping phones (installable, offline app shell). |
| `apps/sap-worker` | Integration worker that runs at K1 HQ beside SAP. Pulls from the cloud over outbound HTTPS and posts via Service Layer. |
| `apps/sap-sl-mock` | In-memory SAP B1 Service Layer (`/b1s/v2`) mock with fault injection, used until the client's SAP test company exists. |
| `packages/shared` | Decimal `Money`, property codes, document numbering format, roles and permissions. |
| `deploy/` | Compose stacks for dev/test on EC2, edge Caddy, env templates. |
| `docs/` | Traceability, brand pack, screenshots. |

## Run locally

Needs Node 22 and Docker (or a local PostgreSQL 16 and Redis 7).

```bash
npm ci
docker compose up -d                      # postgres :5432, redis :6379, SAP mock :50000
npm run build

# migrate as the owner; this also creates the least-privileged runtime role hotel_app
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/hotel APP_DB_PASSWORD=devpw npm run db:migrate
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/hotel SEED_PASSWORD=dev-password-123 npm run db:seed

# API on :3000 (the API never connects as the owner, so row-level security always applies)
export DATABASE_URL=postgres://hotel_app:devpw@localhost:5432/hotel
export REDIS_URL=redis://localhost:6379
export JWT_SECRET=$(openssl rand -hex 32) WORKER_TOKEN=$(openssl rand -hex 32) ENABLE_DEV_ENDPOINTS=true
npm run dev:api

# in other terminals
npm run dev:backoffice                    # http://localhost:5173 (proxies /api)
npm run dev:pwa                           # http://localhost:5174/pwa/
CLOUD_API_URL=http://localhost:3000/api WORKER_TOKEN=$WORKER_TOKEN \
  SL_BASE_URL=http://localhost:50000/b1s/v2 SL_COMPANY_DB=HOTEL_TEST SL_USERNAME=manager SL_PASSWORD=manager \
  npm run dev:worker
```

Seeded users (password = `SEED_PASSWORD`): `admin`, `owner`, `group.accounts` (all properties), `k1.manager`, `k1.reception`, `k1.waiter`, `sw.reception`, `km.reception`.

Try the SAP flow end to end: sign in as `admin`, then

```bash
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"dev-password-123"}' | jq -r .accessToken)
curl -X POST localhost:3000/api/properties/K1/integration/sap/sample-invoice \
  -H "authorization: Bearer $TOKEN" -H "Idempotency-Key: demo-0001"
curl -X POST localhost:50000/mock/faults -d '{"mode":"commit-then-drop"}'   # optional: simulate SAP-AT04
```

The worker posts it to the mock; check **SAP postings** in the back office or `GET localhost:50000/mock/documents`. With the fault on, the first attempt fails, the retry finds the document by `U_HTL_ExtRef`, and exactly one invoice exists.

## Tests

```bash
npm test          # all workspaces
```

API tests run against a real PostgreSQL: the suite drops and recreates `hotel_api_test`, migrates and seeds it. Point it elsewhere with `TEST_DATABASE_ADMIN_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`). Current suite: 75 tests covering RLS property isolation, gapless numbering under concurrency, append-only and finalised-record guards, money domains, idempotent replay including concurrent duplicates, permissions, the worker pull API, and the worker against the Service Layer mock (SAP-AT04/05/06, session expiry).

## Dev and test stacks on EC2 (t4g.large, af-south-1)

All images are multi-arch (`node:22-alpine`, `postgres:16-alpine`, `redis:7.4-alpine`, `caddy:2.10-alpine`) and build natively on ARM64.

```bash
# once: edge Caddy with automatic HTTPS for both stacks
cp deploy/env/edge.env.example deploy/env/edge.env    # set ACME_EMAIL, DEV_DOMAIN, TEST_DOMAIN (DNS A records → the instance)
docker compose -p hotel-edge --env-file deploy/env/edge.env -f deploy/compose.edge.yaml up -d

# each stack has its own project name, env file, database and Redis
cp deploy/env/dev.env.example deploy/env/dev.env      # fill secrets: openssl rand -hex 32
docker compose -p hotel-dev --env-file deploy/env/dev.env -f deploy/compose.stack.yaml up -d --build
docker compose -p hotel-dev --env-file deploy/env/dev.env -f deploy/compose.stack.yaml --profile seed run --rm seed

cp deploy/env/test.env.example deploy/env/test.env
docker compose -p hotel-test --env-file deploy/env/test.env -f deploy/compose.stack.yaml up -d --build
```

Routes per domain: `/api/*` → API, `/pwa/*` → PWA, everything else → back office. Migrations run automatically (`migrate` one-shot service) before the API starts. In production the `sap-worker` container runs at HQ instead, with `CLOUD_API_URL=https://<domain>/api` and the real Service Layer URL; trust SAP's certificate with `NODE_EXTRA_CA_CERTS`, never by disabling TLS checks.

## How the foundation enforces the brief's rules

- **Property scope (SEC-06, AT-18).** Every property-scoped table has a row-level security policy. The API connects as `hotel_app` (no superuser, no BYPASSRLS) and sets `app.property_ids`/`app.all_properties` per transaction; with neither set it sees nothing. Routes with `:propertyCode` narrow the scope to that single property.
- **Numbering (CFG-04, BIL-09).** `next_document_number(property, type)` issues `K1-INV-000123`-style numbers from a locked counter row, inside the business transaction, so numbers are unique group-wide and gapless. Every issued number is logged in an append-only table.
- **Idempotency (§9, BIL-04, AT-03).** Routes marked `@Idempotent()` need an `Idempotency-Key` header. The key row and the business change commit in one transaction; a retry replays the stored response, a concurrent duplicate waits and replays, and a different body with the same key gets 422.
- **Never edit finalised records (§9, BIL-07).** `app_forbid_mutation()` makes ledgers append-only; `app_guard_finalised('col', ...)` freezes a row once `finalised_at` is set, except named status columns, and blocks its deletion.
- **Decimal money (§9).** Postgres domains `money_amount numeric(18,2)`, `money_precise`, `rate`, `quantity` (NaN rejected); TypeScript `Money` refuses floats and allocates splits without losing cents.
- **SAP exactly once (SAP-11, SAP-20, SAP-AT04).** Outbox rows are immutable, claimed with `SKIP LOCKED` and leases; the worker looks up `U_HTL_ExtRef` in SAP before every attempt and only creates the document if it is missing.

## Adding a migration

Create `apps/api/migrations/NNNN_description.sql`. Migrations are forward-only and checksummed: never edit one that has been applied anywhere; add a new one. New property-scoped tables need `property_id`, an RLS policy using `app_property_visible(property_id)`, and grants to `hotel_app` in the same migration.

## Brand

Product name **YeaStay**. Ocean teal `#0E4D52`, Night `#0B2E31`, Sunset amber `#E8A33D` (accent only), Outfit typeface. Logo pack and usage rules: [docs/brand](docs/brand/README.md). On guest documents the property's own name leads, with a small "Powered by YeaStay" footer.
