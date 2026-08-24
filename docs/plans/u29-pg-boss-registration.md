# U29 pg-boss Registration Plan

**Status:** implementation pending

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
- No new packages, public API routes, schema changes, deployments, or changes
  to the legacy/app repositories are part of this worktree.

## Scheduling decision

`backfill-embeddings` remains a manually invoked catch-up worker and receives
no automatic pg-boss schedule. The legacy Railway cron inventory has seven
schedules and only `backfill-event-enrichment` replaces `cron-enrich-events`;
the legacy repository has no cron service or caller that schedules
`backfill-embeddings`. The API's parity registry likewise contains no such
schedule. Tagging already embeds each event inline when `OPENAI_API_KEY` is
configured. Adding a periodic sweep without an authoritative cadence would
create new production behavior rather than porting the old topology.

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
