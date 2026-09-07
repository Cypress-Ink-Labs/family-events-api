# Migration handoff: U31-B onward

**Prepared:** 2026-09-07  
**Primary repository:** `family-events-api`  
**Next unit:** U31-B, event editing and source administration

## Mission

Continue the migration from `family-events-web` and `family-events-backend` to
`family-events-app` and `family-events-api`.

Implement the remaining operator API in bounded slices. Keep the current app
database-backed until U33. Do not deploy or enable a `CUTOVER_*` flag while
implementing U31.

## Repository state

Start by fetching each repository and confirming these commits or their
descendants:

| Repository | Expected `main` | State |
| --- | --- | --- |
| `family-events-api` | `43563af` | U30 and U31-A merged |
| `family-events-app` | `a6e1e93` | Clerk setup and database-backed admin queue merged |
| `family-events-backend` | `8f83f81` | Legacy schema, edge functions, and latest admin search fixes |

The app checkout contains untracked `.serena/` files. They belong to the user.
Do not add, edit, or delete them.

Useful remotes:

- `local`: the user's primary checkout.
- `origin`: the shared GitHub repository.

## Completed work

### API

- U20-U29 from the NestJS rewrite plan are complete.
- U30 notifications are complete:
  - [PR #31](https://github.com/Cypress-Ink-Labs/family-events-api/pull/31)
    added reminder push/in-app and Telegram digest delivery.
  - [PR #32](https://github.com/Cypress-Ink-Labs/family-events-api/pull/32)
    added cancellation, pacing, payload limits, bounded database waits, and
    delivery accounting.
- U31-A is complete in
  [PR #33](https://github.com/Cypress-Ink-Labs/family-events-api/pull/33).

U31-A added:

| Operation | Route |
| --- | --- |
| Review queue | `GET /v1/admin/events` |
| Facets | `GET /v1/admin/events/facets` |
| Single status | `PUT /v1/admin/events/:id/status` |
| Bulk status | `POST /v1/admin/events/bulk-status` |
| Bulk delete | `POST /v1/admin/events/bulk-delete` |

Read these files before adding another admin endpoint:

- `src/admin/admin-review.controller.ts`
- `src/admin/admin-review.input.ts`
- `src/admin/admin-review.dto.ts`
- `src/admin/admin-review.service.ts`
- `src/admin/admin-review.repository.ts`
- `test/admin-review.e2e.test.ts`
- `test/integration/admin-review.integration.test.ts`
- `test/integration/admin-catalog.ts`

The repository establishes transaction-local Supabase claims before invoking
legacy RPCs. HTTP actors never supply their own database UUID:

```text
ClerkAuthGuard
  -> MappedIdentityGuard
  -> OperatorGuard
  -> request.identity.supabaseUuid
  -> set_config('request.jwt.claims', ..., true)
  -> existing public admin RPC
```

For bulk event mutations, authorize against `private.is_admin()` before
acquiring ordered event locks. Keep the RPC authorization check as defense in
depth.

### App

The TanStack Start app already has:

- Clerk sign-in, sign-up, and user controls.
- A database-backed admin review queue at `/admin`.
- Fifteen-second visible-tab polling and loaded-page reconciliation.
- Server functions in `src/fn/admin.ts`.
- Database operations in `src/server/admin.ts`.
- Database-backed Playwright coverage.

The app deliberately calls Postgres directly until U33. Do not replace
`src/fn/admin.ts` with API calls during U31-B.

### Legacy backend

The backend remains the production schema and behavior reference. Existing
migrations are append-only. If a real production defect requires a schema or
RPC change, add a migration and a paired file under `supabase/rollbacks/`.
Never edit an existing migration.

The two latest search corrections are:

- `supabase/migrations/20260902000000_fix_admin_event_facets_escape.sql`
- `supabase/migrations/20260902001000_fix_admin_events_enriched_escape.sql`

## Next scope: U31-B

Split U31-B into two PRs. Event editing and source administration have different
data contracts and failure modes.

### U31-B1: event detail and editing

Required capabilities:

1. Fetch one event with the fields needed by an editor.
2. Fetch its tags and available tag choices.
3. Update an event through the latest five-argument
   `public.admin_update_event` RPC.
4. Pass tag IDs as an explicit array.
5. Support `p_lock_edited_fields`.
6. Support `p_decision_reason`.
7. Unlock admin-managed fields through
   `public.admin_unlock_event_fields`.
8. Preserve audit and `admin_event_decisions` behavior.

Primary legacy sources:

- `family-events-backend/supabase/migrations/20260601021000_admin_event_decisions.sql`
  contains the latest five-argument `admin_update_event`.
- `family-events-backend/supabase/migrations/20260601032000_drop_old_search_events_overload.sql`
  removes the obsolete four-argument overload.
- `family-events-backend/supabase/migrations/20260601000000_schema_baseline.sql`
  contains `admin_unlock_event_fields`, event/tag tables, and field-lock
  behavior.

Do not infer an editable-field allowlist from the RPC body alone. Reconcile it
with:

- current event columns and constraints;
- the app's editor or the legacy web editor;
- `admin_locked_fields`;
- status and LLM-review triggers;
- audit metadata and decision reasons.

Candidate HTTP shape, to confirm after reading the consumers:

```text
GET  /v1/admin/events/:id
PUT  /v1/admin/events/:id
POST /v1/admin/events/:id/unlock
```

Use strict request schemas. Reject unknown patch properties before calling the
database. Preserve nullable versus omitted fields; they have different patch
semantics.

### U31-B2: source administration

Required capabilities:

1. List sources with status and scheduling metadata.
2. Create a source.
3. Update a source.
4. Trigger one source scrape.
5. Change processing mode for one source.
6. Change processing mode in bulk.

Primary legacy sources:

- `family-events-backend/supabase/migrations/20260601003000_maintenance_and_admin_queues.sql`
  contains `admin_create_source` and the original `admin_update_source`.
- `family-events-backend/supabase/migrations/20260601004000_llm_review_and_enrichment.sql`
  contains the latest source update and processing-mode RPCs:
  - `admin_update_source`
  - `admin_bulk_set_processing_mode`
  - `admin_set_event_source_processing_mode`
- `family-events-api/src/pipeline/ingestion/ingestion.repository.ts`
  and `scrape-queue.service.ts` contain the current Nest queue path.
- Search the backend for `enqueue_source_scrape` before designing
  scrape-now. Use the durable source queue; do not invoke an edge function from
  the new API.

Candidate HTTP shape, to confirm after inventory:

```text
GET  /v1/admin/sources
POST /v1/admin/sources
PUT  /v1/admin/sources/:id
POST /v1/admin/sources/:id/scrape
PUT  /v1/admin/sources/:id/processing-mode
POST /v1/admin/sources/bulk-processing-mode
```

## Implementation rules

1. Reuse `AdminModule`, the three-guard chain, typed errors, and the
   controller/service/repository split from U31-A.
2. Parse HTTP input with strict Zod schemas. Keep wire fields in `snake_case`
   and internal fields in `camelCase`.
3. Import local ESM modules with `.js` suffixes.
4. Parameterize every SQL value. Dynamic identifiers require a fixed,
   code-owned allowlist.
5. Use `DbService.withTransaction` for actor claims and multi-step writes.
6. Preserve PostgreSQL timestamp text when microsecond precision matters.
7. Keep bigint and unconstrained numeric values lossless until the DTO boundary.
8. Map database admin-provisioning denial to the stable 403 response. Keep
   member concealment and missing resources at 404.
9. Declare each route and error in OpenAPI. Run `pnpm openapi` and commit
   `openapi.json`.
10. Do not hand-edit generated database types.

## Testing requirements

Each PR needs four layers:

### Parser and service tests

- unknown properties;
- omitted versus explicit null fields;
- UUID and enum validation;
- field-length and array bounds;
- error translation;
- actor UUID taken only from `request.identity`.

### HTTP tests

Use the real guard chain:

- missing or invalid Clerk token -> 401;
- unmapped Clerk user -> 403;
- mapped member -> 404;
- mapped operator without database access -> 403;
- mapped operator with database access -> success;
- invalid input must not reach the repository.

### Real PostgreSQL tests

Use a disposable `pgvector/pgvector:pg17` database. Never run destructive API
integration tests against the shared Supabase port `55322`.

Cover:

- transaction-local actor isolation;
- database access expiry/disablement;
- audit attribution;
- same-value and concurrent updates;
- rollback after audit or dependent-write failure;
- tag replacement and invalid tag IDs;
- field-lock and unlock behavior;
- source queue deduplication for scrape-now;
- production trigger and cascade behavior.

Copy production RPCs into `test/integration/sql/` only after reading the latest
migration chain. Include a source comment and later replacement migrations.
Do not simplify behavior merely to make a fixture pass.

### Contract tests

- verify operation IDs and Clerk security;
- verify nullable and raw timestamp schemas;
- verify closed request bodies;
- verify typed 400/401/403/404 responses;
- regenerate and compare `openapi.json`.

The OpenAPI contract matcher in `test/app.e2e.test.ts` fails on unsupported
schema constraints. Extend it when a new DTO emits a supported constraint;
never let an unknown keyword pass silently.

## Verification commands

### API

```bash
pnpm check
pnpm openapi

docker run --rm -d \
  --name family-events-api-integration \
  -e POSTGRES_PASSWORD=postgres \
  -p 55431:5432 \
  pgvector/pgvector:pg17

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55431/postgres \
  pnpm test:integration

docker rm -f family-events-api-integration
```

Current verified baseline after U31-A:

- `pnpm check`: 93 test files, 1,073 tests.
- Full disposable database run before the last authorization test additions:
  18 files, 273 tests.
- Final admin integration file: 29 tests.
- GitHub CI and integration checks passed on PR #33.

### App

Run these only if the app changes:

```bash
pnpm check
pnpm test
pnpm test:guards
pnpm format:check
```

### Backend

Run these only if the backend changes:

```bash
pnpm run check
pnpm run workspace:test
cd supabase/functions && deno test --allow-env --allow-read
```

Every new backend migration needs a matching rollback SQL file.

## Deployment state and user actions

The new Railway services exist in project `family-events-ui`:

| Service | Railway ID | State |
| --- | --- | --- |
| `api` | `d1928e23-dcdb-48eb-b5f1-6d255e488b8e` | Created, not deployed |
| `app` | `5a2a0107-7efb-4599-8d18-233b00c03cb9` | Created, not deployed |

The user still needs to connect each service to its GitHub repository and add
runtime variables.

Minimum variables:

- both services: Supabase session-pooler `DATABASE_URL`;
- API: `CLERK_SECRET_KEY`, `NODE_ENV=production`;
- app: `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
  `CLERK_WEBHOOK_SIGNING_SECRET`;
- after the app receives a public domain: API `WEB_ORIGIN`.

Do not print or copy values from `.env` files. Ask the user to set missing
secrets in Railway.

The first deployment is shadow-only:

- leave every `CUTOVER_*` flag disabled;
- verify API `/healthz` and `/readyz`;
- verify app `/healthz`, event browsing, and Clerk sign-in;
- verify one operator identity;
- do not disable legacy cron services.

## Work after U31-B

### U31-C

- users;
- access control;
- invitations.

### U31-D

- AI settings;
- dashboards and statistics;
- dead-letter retry/delete;
- cron list/toggle/schedule/history.

Use polling for the first admin cutover. The current app already polls every 15
seconds, and adding SSE during migration would increase the cutover surface.

### U32

- Sentry;
- structured request and worker logs;
- separately authenticated pg-boss dashboard;
- Railway/deployment configuration and secret parity.

### U33

1. Add the app's authenticated API client and API URL.
2. Replace app database-backed server functions in bounded feature slices.
3. Transfer worker ownership one family at a time.
4. Verify run history and rollback after each transfer.
5. Remove a legacy service only after a stability window.

## Stop conditions

Stop and ask before proceeding when:

- the latest legacy function signature differs from the one listed here;
- the app and backend disagree on editable fields or null semantics;
- scrape-now cannot use the durable queue without a schema change;
- an RPC requires editing an existing migration;
- a production migration lacks an obvious rollback;
- an endpoint would expose a database actor ID supplied by the client;
- tests would need the shared local Supabase database;
- deployment requires a secret or a `CUTOVER_*` change.

Do not guess across these boundaries.
