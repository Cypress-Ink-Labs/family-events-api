# NestJS backend rewrite plan (reconstructed) — units U20–U33

**Status:** U20 and U22 done; U23 write repositories landed; U27 foundation landed
(topology + gate); U28/U30 pure-logic ports landed; everything else pending.
**Supersedes:** old U13–U18 of `2026-08-14-001` (production-readiness plan), per the mid-session
redirect: *everything server-side moves to NestJS*.

## Provenance — read this first

The original `2026-08-16-001-nestjs-backend-rewrite-plan.md` was drafted by a planner
subagent on the author's Mac and exists **only** there (`/Users/lecoqjacob/Projects/
personal/web/family-events/docs/plans/`, not a git repo). This document is a
**reconstruction** produced by a cloud agent from:

- the `ce-handoff` snapshot of that session (unit range U20–U33, decisions, completed units),
- a full architectural inventory of `Cypress-Ink-Labs/family-events-backend` @ `c47b534`,
- a full API-surface inventory of `Cypress-Ink-Labs/family-events-web` (old SPA, reference),
- the four decisions resolved by the user on 2026-08-16.

**Reconciliation update (2026-08-16, later same day):** `family-events-app` @ `97b6284`
has now been read in full and this plan is reconciled against it. Key corrections applied:

- **Cutover flags are per *job family*** (`CUTOVER_SCRAPE|TAG|REVIEW|DIGEST|REMINDERS|NOTIFY`,
  worker `flags.ts` semantics: production = exact `"true"` required, non-prod = on unless
  `"false"`), not per family slug as first reconstructed.
- **Queue topology follows the U12 worker registry verbatim** (`src/pipeline/families.ts`):
  six job families with per-family DLQs, retry 3/30s/backoff, digest+reminders strictly
  serial; db-maintenance is *not* a job family (old pipeline until U18). The legacy
  Railway-label mapping survives in each schedule's `replaces` field, which is what the
  kill switch and run history key on.
- **Operator routes hide as 404, not 403** (U9 decision, mirrored from
  `requireOperatorIdentity`).
- The old plan's **U13–U18 meanings recovered** from app-repo references: U13 DLQ
  alerting, U14 scrape handlers, U15 tag/review handlers, U16 digest/reminders/notify +
  Railway IaC, U18 flip cutover flags + move db-maintenance. U20–U33 still supersede them.
- The consumer wire contract for U24–U26 is `src/fn/consumer.ts` (13 server functions,
  TS interfaces, no zod): explore/search keyset `(start_datetime, id)` page 24, map
  limit 200, plan-for-today limit 5, detail+similar+comments+ratings, favorites,
  calendar, submit (5/24h rate limit), plus the not-yet-exposed `preferred-cities`
  module. Webhooks: Svix-verified Clerk endpoint, log-only until U7.

## Decisions (resolved 2026-08-16)

1. **Repo topology:** `family-events-api` is a **standalone repo** in Cypress-Ink-Labs.
2. **Web-to-API contract:** **OpenAPI + generated client** (`@nestjs/swagger` emits
   `openapi.json`; CI fails on drift; the app generates its typed client from it).
3. **U9 (admin ops) / U10 (web push):** build **against the new API** when picked up.
4. **Timing:** NestJS phases run **now, pre-cutover**. The legacy pipeline keeps running;
   the **single-writer rule** holds until U33 stage-by-stage cutover.

## What is being replaced

| Legacy component | Where it lives today | Replacement |
| --- | --- | --- |
| ~30 Deno edge functions (pipeline + notify + public feeds) | `family-events-backend/supabase/functions/` | NestJS modules + pg-boss workers |
| 8 Railway cron containers curling edge functions | `family-events-backend/cron/`, `.railway/railway.ts` | pg-boss schedules (`src/pipeline/schedules.ts`, parity-tested) |
| Postgres RPC surface consumed by the frontend (~45 RPCs) | Supabase PostgREST | OpenAPI REST endpoints |
| TanStack Start server functions (invisible repo) | `family-events-app/src/server/` | Same NestJS API |
| Supabase Auth (old SPA) / Clerk (new app) | mixed | Clerk only, via `clerk_user_mapping` seam (U19) |
| Durable Postgres queues (`source_scrape_queue`, `event_tag_queue`, `event_llm_review_queue`, `notification_queue`) | migrations + claim RPCs | keep tables initially; workers move to pg-boss-scheduled NestJS services; queue-table consolidation is a post-cutover decision |

Not replaced: the Postgres schema itself (58 migrations stay authoritative), Supabase
Realtime channels (replacement strategy decided in U31), the old SPA.

## Units

### U20 — API scaffold + CI ✅ (done, this session)
Standalone NestJS 11 app: zod-validated env (incl. `CUTOVER_FAMILIES` single-writer
guard), `DbService` with U6 conventions (timestamptz-as-microsecond-text for keyset
cursors, recursive `Json` type), pg-boss lifecycle module, Clerk bearer guard (fails
closed), `/healthz` + `/readyz`, OpenAPI emission with CI drift check, vitest/oxlint/
oxfmt house tooling, GitHub Actions (unit + Postgres-service integration jobs).

### U21 — Contract foundation + generated client
Freeze the consumer-facing DTOs (enriched event, plan scores, profile, city) as
`@nestjs/swagger` classes; wire client generation (openapi-typescript or equivalent)
into `family-events-app`; CI on the app side regenerates and typechecks against
`openapi.json`. **Blocked on app repo access** for the client half; API half can proceed.

### U22 — Identity: Clerk + mapping seam ✅ (done, this session)
U19's `clerk_user_mapping` consumption: request identity = Clerk `sub` mapped to
`supabase_uuid` (uuid-mapping mode) until U7 retypes FKs — landed as
`IdentityService` + `MappedIdentityGuard` (verified-but-unprovisioned = 403) +
`OperatorGuard` for the admin surface, with unit and real-Postgres integration tests
mirroring the migration DDL (FK cascade, shape/role checks). Provisioning script
stays in family-events-backend until cutover.

### U23 — Data access layer 🟡 (write repositories landed)
Repositories over the existing schema for events, sources, queues, users, notifications.
Integration-tested against real Postgres (CI service container; locally the Supabase
stack on 127.0.0.1:55322). Port `packages/contracts` generated types or regenerate.
**Write-side consumer repositories landed:** `FavoritesRepository`, `CalendarRepository`,
`RatingsRepository`, `CommentsRepository`, `SubmissionsRepository` (with transactional
5-per-24h rate limit), `PreferredCitiesRepository` (demote-first semantics), all ported
field-for-field from `family-events-app` server modules with idempotent `ON CONFLICT`
semantics and integration test coverage. Remaining: read-side repositories for events,
sources, queues, notifications.

### U24 — Consumer read API
Parity endpoints for `search_events` (keyset cursor `(start_datetime, id)`, page 24),
`events_enriched` batch hydration, event detail + `find_similar_events_by_id`, tags,
cities, `public_events` preview. Contract fidelity matters more than SQL reuse: the
RPCs' SQL can be called directly initially, then inlined.

### U25 — Consumer write API
Favorites, calendar, ratings, comments, profile + preferred cities (U6b demote-first
semantics), notification prefs/inbox (`mark_*_read`), `submit_community_event`,
invites (`redeem/request/claim`). All behind the Clerk guard.

### U26 — Plan feature
`plan_events_first_nonempty_window` (D+0..7, limit 3) + weather proxy (OpenWeatherMap)
+ `plan_events_for_user_range` 8-factor scoring parity (distance, weather, age,
history_affinity, family_fit, timing, novelty, budget).

### U27 — Pipeline foundation 🟡 (topology + gate landed)
pg-boss queue topology mirroring the 8 cron services — **landed with parity tests**;
registration deliberately deferred per single-writer rule. Kill-switch parity
(`private.cron_enabled` per legacy label, missing-row-means-enabled) and run-history
writes (`private.railway_cron_runs` continuity for the admin UI) — **landed as
`CronGateService.runGated` with unit + real-Postgres integration tests**. Remaining:
U3 Telegram failure pings, per-stage `CUTOVER` gating so individual queues can be
enabled independently at U33.

### U28 — Ingestion port 🟡 (dedup landed)
`scrape-due-sources` → `run_due_source_scrapes` enqueue; source-queue worker (claim 1,
SKIP LOCKED); the 9 parser adapters (website/rss/ical/manual/macaronikid/brec/
downtownlafayette/lcglafayette/localhop); guarded-fetch SSRF + image-host allowlist;
`bulk_import_scrape_events`; cross-source dedup (**pure logic ported with full test
suite**: fingerprint or Jaccard ≥ 0.7 within ±4h, plan 033); zero-result stale
escalation (threshold 3, audit log, scheduler exclusion — plans 034/U1).

### U29 — Classification + enrichment port
Tag queue worker (batch 20, concurrency 4) + LLM tagging; review queue worker
(concurrency 3, 110s budget, release-unstarted — plan 037) + memory-context bulk
hydration (036); enrichment/backfill, embeddings (OpenAI), parent tips, geocode
(Nominatim, degrade on 429), stock images (Unsplash/Pexels/Pixabay). LLM routing via
`approved_ai_models` / `ai_feature_config`.

### U30 — Notifications port 🟡 (weekend window landed)
`notification_queue` processing with fail-before-side-effects hydration semantics (032);
reminders (no-retry); weekly digest: recipient keyset pagination (035), Chicago weekend
window (**pure logic ported with DST tests**, plan 031), Resend + react-email templates,
web push (VAPID) + APNs + FCM, Telegram digest + `digest_telegram` prefs.

### U31 — Admin API port
The ~30 `admin_*` RPCs as operator-guarded endpoints: review queue (cursor
`(created_at, id)`, limit 200/max 500), facets, status/batch/delete, event editor +
unlock, sources CRUD + scrape-now + bulk processing mode, dead-letter retry/delete
(incl. U2 redrive), users/access/invites, AI settings, dashboards/stats, cron
admin (list/toggle/schedule/history — now backed by pg-boss). Decide realtime
replacement here (poll vs SSE); the old SPA's four Supabase channels are reference.

### U32 — Observability + deployment
Sentry, structured logs, `@pg-boss/dashboard` as separate basic-auth Railway service
(documented U12 deviation), Railway service for the API in project `family-events-ui`,
deploy-cli/IaC updates, secret management parity (`.env.example` is the authoritative
var list).

### U33 — Staged cutover + decommission (operator-gated)
Per-stage: enable pg-boss queue → disable matching Railway cron via `private.cron_enabled`
→ verify run history + outcomes → remove cron service from IaC. Per-family consumer
cutover via `CUTOVER_<FAMILY>`/`CUTOVER_FAMILIES`. Coordinates with operator-gated
U7 (FK retype), U11 (production cutover), U18 (old-pipeline decommission). Old
pipeline remains the single writer for any stage/family not yet flipped.

## Sequencing and parallelism

U21+U22 unblock everything consumer-facing; U23 unblocks U24–U26 (parallel) and
feeds U28–U31. U27→U28→U29→U30 is the pipeline spine (U28/U29/U30 internally
parallelizable per queue). U31 anytime after U23. U32 rides along. U33 last, staged.
**U23 write repositories partially unblock U25:** the consumer write API can proceed
for favorites, calendar, ratings, comments, submissions, and preferred cities.

## Standing blockers (user action)

1. **`family-events-app` is invisible to agent credentials** — blocks U21 client half
   and contract reconciliation for U24–U26.
2. **No write access to Cypress-Ink-Labs** — work lands on the hm-dotfiles transfer
   branch until `family-events-api` exists as a repo (extraction steps in
   `family-events/README.md`).
3. **Original plan docs machine-local** — commit `docs/plans/` from the Mac into a repo,
   then reconcile this reconstruction against `2026-08-16-001`.
4. Operator-gated as before: Clerk production keys, U19 production provisioning run,
   U7/U11/U18, Railway provisioning.

## Quality gates (every unit)

`pnpm check` (format, lint, typecheck, unit tests) + `pnpm test:integration` against
real Postgres + OpenAPI drift check. A unit lands only with its tests green — same
discipline as U1–U19.
