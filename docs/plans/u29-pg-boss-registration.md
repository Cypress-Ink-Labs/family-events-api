# U29 pg-boss Registration Plan

**Status:** complete

**Goal:** install the already-ported tag, review, and enrichment workers in the
NestJS pg-boss host without violating the pre-U33 single-writer rule.

## Sources and constraints

- `docs/plans/2026-08-16-002-nestjs-backend-rewrite-plan.md` defines U29 and
  keeps the legacy pipeline authoritative until the staged U33 cutover.
- `~/Projects/personal/web/2026-08-23-003-migration-next-steps.md` assigns the
  tag and review families to `CUTOVER_TAG` and `CUTOVER_REVIEW`, respectively,
  and places enrichment on the existing tag-family schedule.
- `src/pipeline/ingestion/scrape-queue.service.ts` is the registration and
  `CronGateService.runGated` template.
- `src/pipeline/families.ts` remains the topology source of truth: tag owns
  `process-tag-queue` and `backfill-enrichment`; review owns
  `process-review-queue`.
- Production defaults stay fail-closed. A family registers no queue, DLQ,
  worker, or schedule unless its exact `CUTOVER_*` value is `"true"`.
- Registration is only ownership preparation. While the matching legacy
  `private.cron_enabled` label is true (or absent), Nest skips execution. The
  atomic `true` to `false` database update stops the legacy runner and starts
  Nest on the next tick, so both writers never run from the same gate state.
- Each schedule also has a namespaced Nest operational label,
  `nestjs:<legacy-label>`, in the same table. Missing means enabled. Nest runs
  only when the legacy label is false and the namespaced label is true.
- No new packages, public API routes, schema changes, deployments, or changes
  to the legacy/app repositories are part of this worktree.
- pg-boss always fetches one job per callback. Family concurrency maps to
  `localConcurrency`, which spawns independent single-job workers; one thrown
  handler therefore retries only its own job rather than a successful sibling
  fetched in the same batch.

## Scheduling decision

`backfill-embeddings` remains a manually invoked catch-up worker and receives
no automatic pg-boss schedule. The legacy Railway cron inventory has seven
schedules and only `backfill-event-enrichment` replaces `cron-enrich-events`;
the legacy repository has no cron service or caller that schedules
`backfill-embeddings`. The API's parity registry likewise contains no such
schedule. Tagging already embeds each event inline when `OPENAI_API_KEY` is
configured. Adding a periodic sweep without an authoritative cadence would
create new production behavior rather than porting the old topology.

This was verified against `.railway/railway.ts`,
`infra/railway-cron-drift/cron-services.json`, `config/deploy.config.json`, and
repository history. `supabase/docs/SEMANTIC_SEARCH.md` calls the function a
cron, but the deployed IaC and history contain no corresponding scheduler, so
the executable sources take precedence over that stale description.

## Implementation slices

### 1. Tag family

1. Add failing registration and dispatch tests for disabled/enabled flags,
   queue/DLQ/schedule parity, unknown tasks, cron gating, self-chaining, and
   enrichment dependency construction.
2. Add `TagQueueService` that registers the tag family behind `CUTOVER_TAG`.
3. Bind `processTagQueueBatch` to `processTagEvent`, `embedEvent`, and the
   existing classification/enrichment repositories.
4. Run `backfill-enrichment` through `runEnrichmentTick` and
   `CronGateService.runGated`.
5. Read `UNSPLASH_ACCESS_KEY` once and assign it to both
   `providerKeys.unsplash` and `unsplashAccessKey`; tests pin the equality.
6. Run the focused tests and commit `U29: register tag and enrichment jobs`.

### 2. Review family

1. Add failing registration and dispatch tests for disabled/enabled flags,
   queue/DLQ/schedule parity, unknown tasks, and cron gating.
2. Add the repository query needed to preserve legacy
   `ai_feature_config(feature = 'event-review')` routing, falling back to env
   configuration if the lookup is unavailable.
3. Add `ReviewQueueService` that registers the review family behind
   `CUTOVER_REVIEW` and binds `processReviewQueueBatch`.
4. Run focused unit/integration tests and commit
   `U29: register review queue jobs`.

### 3. Module and boot safety

1. Register and export both services from `PipelineModule`.
2. Add full Nest boot smoke tests with tag/review flags disabled and enabled;
   the disabled boot must register neither family, while the enabled boot must
   expose exactly their queues and schedules.
3. Update the master plan to mark U29 registration complete and record the
   no-schedule embeddings decision.
4. Run `pnpm check`, `pnpm test:integration`, and an OpenAPI drift check.
   This slice adds no controllers, so `openapi.json` must remain unchanged.
5. Commit `U29: complete pg-boss pipeline registration`.

## Completion evidence

- Focused RED/GREEN output for each service.
- Unit suite, formatting, lint, and typecheck via `pnpm check`.
- Full real-Postgres integration suite via `pnpm test:integration`.
- `pnpm openapi` followed by a clean `openapi.json` diff.
- Atomic `U29:` commits, no push or deployment.

## U33 handoff and stop procedure

For each family, set `CUTOVER_<FAMILY>=true` and restart the API first. Confirm
the pg-boss queue, worker, and schedule exist while the Nest handler still
skips because the legacy label remains enabled. Leave the namespaced
`nestjs:<legacy-label>` row absent (enabled by default), or explicitly set it
to true. Then atomically set the matching legacy
`private.cron_enabled.enabled` value to `false`; the legacy runner stops and
Nest begins on its next scheduled delivery. Verify
`private.railway_cron_runs` before removing the legacy Railway service.

An operational pause sets `nestjs:<legacy-label>=false` while leaving the
legacy label false. The worker keeps consuming scheduled pg-boss deliveries
and completes them as skipped, so no replay backlog accumulates. Resume by
setting the namespaced label true. For rollback, set the namespaced Nest label
false first, verify Nest has stopped, and only then set the legacy label true;
this ordering permits a no-writer gap but never dual writers. These labels can
be managed through the existing `admin_set_cron_enabled` upsert because it
accepts arbitrary labels.
