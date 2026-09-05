# NestJS backend rewrite plan (reconstructed) — units U20–U33

**Status:** U20–U29 done. U30 email delivery and its event-change
notification queue, in-app delivery, Web Push, and FCM path are merged.
Reminder push/in-app delivery and Telegram digest remain, followed by U31–U33.
Railway configuration is merged and empty `api` / `app` shadow services exist,
but neither service is deployed because production database and Clerk variables
have not been supplied.
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

### U21 — Contract foundation + generated client 🟡 (client half landed)
Freeze the consumer-facing DTOs (enriched event, plan scores, profile, city) as
`@nestjs/swagger` classes; wire client generation (openapi-typescript or equivalent)
into `family-events-app`; CI on the app side regenerates and typechecks against
`openapi.json`. **Client half landed:** `family-events-app` vendors the contract at
`contracts/openapi.json` and generates TypeScript client types at
`src/lib/api-client/schema.gen.ts` via `openapi-typescript@7.13.0`. CI guard
(`tests/guards/api-client-drift.test.mjs`) ensures the generated types stay in sync
with the vendored contract. Nothing imports the generated types yet; runtime cutover
is U33. API half can proceed in parallel.

### U22 — Identity: Clerk + mapping seam ✅ (done, this session)
U19's `clerk_user_mapping` consumption: request identity = Clerk `sub` mapped to
`supabase_uuid` (uuid-mapping mode) until U7 retypes FKs — landed as
`IdentityService` + `MappedIdentityGuard` (verified-but-unprovisioned = 403) +
`OperatorGuard` for the admin surface, with unit and real-Postgres integration tests
mirroring the migration DDL (FK cascade, shape/role checks). Provisioning script
stays in family-events-backend until cutover.

### U23 — Data access layer ✅ (done: read + write repositories) 🟡 (write repositories landed)
Repositories over the existing schema for events, sources, queues, users, notifications.
Integration-tested against real Postgres (CI service container; locally the Supabase
stack on 127.0.0.1:55322). Port `packages/contracts` generated types or regenerate.
**Write-side consumer repositories landed:** `FavoritesRepository`, `CalendarRepository`,
`RatingsRepository`, `CommentsRepository`, `SubmissionsRepository` (with transactional
5-per-24h rate limit), `PreferredCitiesRepository` (demote-first semantics), all ported
field-for-field from `family-events-app` server modules with idempotent `ON CONFLICT`
semantics and integration test coverage. Remaining: read-side repositories for events,
sources, queues, notifications.

### U24 — Consumer read API ✅ (done)

The live app's seven consumed reads are covered by `GET /v1/cities`, `GET /v1/events`
(explore/search with `(start_datetime, id)` keyset cursors and page size 24),
`GET /v1/events/map` (published, coordinate-bearing events; max 200),
`GET /v1/events/:id/detail` (published enriched event, four similar titles, approved
comments, and optional caller rating), `GET /v1/plan` (24-hour window; max 5), plus
mapped-user-only `GET /v1/me/favorites` and `GET /v1/me/calendar`. The latest
`find_similar_events_by_id` SQL is installed verbatim in disposable integration tests;
`events_enriched` hydration applies an outer published-status filter so event-ID reads
cannot expose drafts.

Notification preferences/inbox reads, invite reads, and the `public_events` preview are
explicitly excluded: `family-events-app/src/fn/consumer.ts` imports no corresponding
server function or module. They remain owned by later notification/admin work rather
than an invented U24 contract.

### U25 — Consumer write API ✅ (done)
Favorites, calendar, ratings, comments, profile + preferred cities (U6b demote-first
semantics), notification prefs/inbox (`mark_*_read`), `submit_community_event`,
invites (`redeem/request/claim`). All behind the Clerk guard.

### U26 — Plan feature ✅ (done)
`GET /v1/plan`: 24-hour window (now to now+24h), optional `city_id`/`kid_age`, calls
`PlanRepository.planForRange` → `plan_events_for_user_range` RPC with named parameters
(weatherFit neutral, limit 5). `WeatherService` ported from the weather edge function:
OpenWeatherMap integration (5s timeout), outdoor/indoor/any mapping from conditions +
temperature, graceful degradation to neutral when unconfigured or failed (never throws
into request path). Integration fixture: verbatim `plan_events_for_user_range` RPC
definition (byte-identical from `20260724020000`, grants stripped), 8-factor scoring
(distance, weather, age, history_affinity, family_fit, timing, novelty, budget).

### U27 — Pipeline foundation ✅ (done)
pg-boss queue topology mirroring the 8 cron services — **landed with parity tests**.
Atomic ownership handoff (`private.cron_enabled` per legacy label,
missing-row-means-legacy-enabled) and run-history writes
(`private.railway_cron_runs` continuity for the admin UI) — **landed as
`CronGateService.runGated` with unit + real-Postgres integration tests**. A CUTOVER flag
prepares pg-boss ownership; Nest execution stays blocked until the atomic legacy-label
disable starts the new owner. Independent `nestjs:<legacy-label>` rows provide Nest pause
control without re-enabling legacy or accumulating unconsumed pg-boss jobs.
U3 Telegram failure pings — **landed via `FailurePingService`** (posts to Telegram Bot
API with legacy HTML format, 500-char error slice, kind labels `run failed`/
`dead-lettered`/`function crashed`, 10s timeout, bot-token redaction; missing env is
silent skip). Per-stage `CUTOVER` gating — **landed with U28's `ScrapeQueueService`**:
`JobsService` gained keyed multi-schedules, dead-letter queue registration, and work
concurrency with isolated single-job settlement (`batchSize: 1` plus
`localConcurrency`); each family registers behind its own `CUTOVER_<FAMILY>`
creation-time gate, so U33 can flip stages independently.

### U28 — Ingestion port ✅ (done)
Landed across four stacked PRs (shared utils → parsers → import path → worker):
`scrape-due-sources` → `run_due_source_scrapes` enqueue and `cleanup-stale-runs` →
`run_cleanup_stale_runs`, both `CronGateService.runGated`-wrapped pg-boss schedule
tasks; source-queue worker (claim 1, SKIP LOCKED via `claim_source_scrape_queue_batch`,
5/15/60-min retry ladder, dead at attempt 4, extraction traces, run/dead-letter
Telegram pings); the 9 parser adapters (website/rss/ical/manual/macaronikid/brec/
downtownlafayette/lcglafayette/localhop, `@b-fuze/deno-dom` → linkedom, fixtures
byte-identical); guarded-fetch SSRF (DNS + every redirect hop) + image-host allowlist;
`bulk_import_scrape_events` via the same public RPC wrappers PostgREST exposed;
cross-source dedup pre-pass (fingerprint or Jaccard ≥ 0.7 within ±4h, plan 033;
candidate datetimes re-serialized as UTC ISO to keep fingerprint minute-slicing
correct over pg text format); zero-result stale escalation (threshold 3, audit log —
plans 034/U1). The scrape family registers behind `CUTOVER_SCRAPE` (queue + `scrape.dlq`
+ both schedules), completing the U27 tail; the legacy HTTP kick became a chained
`drain-source-queue` pg-boss job (claim-1 semantics preserved). Queue RPC SQL extracted
verbatim into `test/integration/sql/`; boot verified both ways (flag on: queue +
schedules created; production without flag: nothing installed). LLM fallback extraction
ported (`llm-config`/`llm-openai`, `deterministic_then_llm` semantics, 45s budget).

### U29 — Classification + enrichment port ✅ (done)
Tag queue worker (batch 20, concurrency 4) + LLM tagging; review queue worker
(concurrency 3, 110s budget, release-unstarted — plan 037) + memory-context bulk
hydration (036); enrichment/backfill, embeddings (OpenAI), parent tips, geocode
(Nominatim, degrade on 429), stock images (Unsplash/Pexels/Pixabay). LLM routing via
`approved_ai_models` / `ai_feature_config`.

pgvector infrastructure for event similarity: `event_embeddings` table, HNSW cosine
index + event_id covering index, `private.find_similar_events` and
`public.find_similar_events` RPCs — **wired into integration test catalog with full
test suite** (`.github/workflows/ci.yml` switched to `pgvector/pgvector:pg17` image;
`test/integration/sql/event_embeddings_similarity.sql` extracted verbatim from
`20260601020000_event_embeddings_and_similarity.sql`; `ClassificationRepository.findSimilarEvents`
integration tests cover threshold/limit/exclude/city filtering).

Enrichment slice landed: backfill claim + `enrichOne`, tick orchestration (tracking,
attribution backfill, parent-tips passes), parent-tips generation port, and
`EnrichmentRepository` (implements `EnrichmentDb`/`EmbeddingsBackfillDb`, registered
in `PipelineModule`) covering the enrichment/embeddings/parent-tips seams end to end,
backed by `test/integration/sql/event_enrichment_rpcs.sql` and
`list_events_needing_embeddings.sql`.

The final registration slice installs `TagQueueService` and `ReviewQueueService`
behind the production-fail-closed `CUTOVER_TAG`/`CUTOVER_REVIEW` creation-time gates.
The tag family owns the parity `process-tag-queue` and `backfill-enrichment` schedules;
the review family owns `process-review-queue`. Both use the existing queue/DLQ retry
topology and `CronGateService` history/kill-switch path. Enrichment supplies the same
`UNSPLASH_ACCESS_KEY` to search, download tracking, and attribution backfill.
`backfill-embeddings` deliberately remains manual: deployed legacy IaC and repository
history contain no scheduler, while tag-event already embeds routine writes inline.
Boot tests pin both flag directions so safe production defaults install no ownership
before U33.

### U30 — Notifications port 🟡 (event-change family landed in #30)

Daily reminders and the weekly digest are implemented as strictly serial, no-retry
pg-boss families behind `CUTOVER_REMINDERS` / `CUTOVER_DIGEST` plus the atomic
legacy-cron handoff. The slice includes recipient keyset pagination, Chicago day/weekend
windows, soft-fail Resend delivery, the hosted reminder template, and raw branded digest
HTML. The event-change slice keeps `notification_queue` as its transactional
one-hour debounce buffer and adds a serial internal poller, fail-before-side-effects
hydration (032), in-app notifications, trusted-provider Web Push, and FCM for the
deployed iOS/Android token contract. Direct APNs is deferred until subscriptions
carry an explicit provider discriminator. Remaining: reminder push/in-app delivery
and Telegram digest + `digest_telegram` preferences.

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
var list; U27 introduced `TELEGRAM_BOT_TOKEN` + `TELEGRAM_FAILURE_CHAT_ID`; U26
introduced `OPENWEATHER_API_KEY` as optional configuration).

### U33 — Staged cutover + decommission (operator-gated)
Per-stage: enable pg-boss queue (Nest remains gated) → disable matching Railway cron via
`private.cron_enabled` (Nest begins) → verify run history + outcomes → remove cron service
from IaC. Pause Nest with `nestjs:<legacy-label>=false` while leaving legacy disabled;
rollback sets that Nest label false before re-enabling legacy. Per-family consumer
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

1. **No write access to Cypress-Ink-Labs** — work lands on the hm-dotfiles transfer
   branch until `family-events-api` exists as a repo (extraction steps in
   `family-events/README.md`).
2. **Original plan docs machine-local** — commit `docs/plans/` from the Mac into a repo,
   then reconcile this reconstruction against `2026-08-16-001`.
3. Operator-gated as before: Clerk production keys, U19 production provisioning run,
   U7/U11/U18, Railway provisioning.

## Quality gates (every unit)

`pnpm check` (format, lint, typecheck, unit tests) + `pnpm test:integration` against
real Postgres + OpenAPI drift check. A unit lands only with its tests green — same
discipline as U1–U19.
