# U29 Enrichment Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the legacy enrichment pipeline — `backfill-event-enrichment` (geocode + stock images + parent-tips pass), `backfill-embeddings`, `embed-event`, `generate-parent-tips` — from `family-events-backend` Deno edge functions into `family-events-api` as pure workers behind Db seams, with an `EnrichmentRepository`, verbatim SQL fixtures, and full test coverage. **No pg-boss registration in this slice** (that is the next step of U29, deliberately last).

**Architecture:** Same three-layer pattern as the shipped tag/review slices: (1) verbatim legacy RPC fixtures + integration smoke tests, (2) pure worker modules that take a `*Db` interface parameter (zero pg/Nest imports), (3) an `@Injectable()` repository implementing the seams with SQL mirroring the legacy RPCs. Parent-tips generation is folded in-process (legacy did HTTP fan-out between edge functions; here it's a direct function call).

**Tech Stack:** NestJS 11, pg, vitest, disposable Postgres (`pgvector/pgvector:pg17`), OpenAI chat + embeddings APIs, Nominatim, Pexels/Pixabay/Unsplash.

**Specs (authority order):**
1. `docs/plans/2026-08-16-002-nestjs-backend-rewrite-plan.md` §U29 (scope)
2. `~/Projects/personal/web/2026-08-23-003-migration-next-steps.md` step 2 (sequencing)
3. Legacy source of truth: `~/Projects/personal/web/family-events-backend/supabase/functions/{backfill-event-enrichment,backfill-embeddings,embed-event,generate-parent-tips}/` and `supabase/migrations/` (latest `CREATE OR REPLACE` wins)

## Global Constraints

- **No pg-boss registration in this slice.** `TagQueueService`/`ReviewQueueService`/enrichment scheduling is the next U29 step. Nothing here runs automatically; the legacy pipeline remains the single production writer.
- **Verbatim SQL discipline:** RPC fixtures in `test/integration/sql/` are byte-copies of the latest legacy migration version (strip only GRANT/REVOKE/COMMENT/RLS). Fix the test catalog, not the SQL. Header comment documents source migration file + line numbers per function.
- **Migration chronology gotcha:** legacy migration files are squashed bundles with `-- Source: <original>.sql` markers. "Latest" = last occurrence scanning files in filename order, top-to-bottom within a file.
- **Fidelity-first porting.** Deviations only toward safety/human review, annotated in code comments and listed in §Deliberate deviations below. New deviations require adding to that list.
- **Worker purity:** worker modules import no `pg`, no Nest. All DB access via the seam interface. Unit tests use hand-written `Fake*Db` classes (in-memory Maps/Sets), no mocking library.
- **Integration DB guards:** tests use `createIntegrationDb()` from `test/integration/db.ts` (loopback only, refuses port 55322). Anything touching `event_embeddings` needs the pgvector fixture layer (`test/integration/sql/event_embeddings_similarity.sql`) — it is deliberately NOT in the base catalog.
- **Quality gates:** `pnpm check` (format+lint+typecheck+unit) and `pnpm test:integration` green at every commit. OpenAPI drift: this slice adds no controllers, `openapi.json` must not change.
- **Merges are gated on Jacob's explicit in-session go. No exceptions.**
- Commit message convention: `U29: <description>` (matches `git log`).

## File Structure

```
src/pipeline/enrichment/
  embed-event.ts                        # EmbedEventDb seam, embeddings client, embedEvent
  embed-event.test.ts
  process-embeddings-backfill.ts        # EmbeddingsBackfillDb seam + worker
  process-embeddings-backfill.test.ts
  parent-tips-prompt.ts                 # verbatim prompt port (parent-tips-v1)
  generate-parent-tips.ts               # ParentTipsDb seam, config resolution, generation
  generate-parent-tips.test.ts
  process-enrichment-backfill.ts        # EnrichmentDb seam, enrichOne, aux passes, runEnrichmentTick
  process-enrichment-backfill.test.ts
  enrichment.repository.ts              # EnrichmentRepository implements all seams
src/pipeline/llm-openai.ts              # MODIFY: add postOpenAiEmbedding
test/integration/catalog.ts             # MODIFY: event_image_attributions + events columns
test/integration/ingestion-catalog.ts   # MODIFY: wire new fixture
test/integration/sql/event_enrichment_rpcs.sql
test/integration/sql/list_events_needing_embeddings.sql
test/integration/enrichment-rpcs.integration.test.ts
test/integration/enrichment.repository.integration.test.ts
src/pipeline/pipeline.module.ts         # MODIFY: register EnrichmentRepository
```

Existing modules consumed (do NOT re-port):
- `src/pipeline/geocode.ts` — `geocodeViaNominatim(query)`, `buildGeocodeQuery({address, venueName, cityName, cityState})`
- `src/pipeline/stock-images.ts` — `findFallbackImage(tags, providerKeys, {fetchImpl?, title?})`, `deriveTitleSearchTerm`, `StockImageProviderKeys`
- `src/pipeline/unsplash.ts` — `trackUnsplashDownload` (:160), `lookupUnsplashPhotoFromUrl` (:190)
- `src/pipeline/llm-config.ts` — `resolveSharedLlmConfig(descriptor, env)`
- `src/pipeline/llm-openai.ts` — `postOpenAiChatCompletion`

## Deliberate deviations from legacy (annotate each in code)

1. **Parent-tips in-process:** legacy `backfill-event-enrichment/parent-tips-pass.ts` HTTP-invoked `generate-parent-tips` per event (30s timeout each). Port calls `generateParentTipsForEvent()` directly. Legacy 503 semantics become typed results: `feature-disabled` / `not-configured` (the pass still **breaks the whole batch** on `not-configured`, and still calls `markEnrichmentAttempt` on other failures — same as legacy).
2. **Config loaded once per pass:** legacy checked `ai_feature_config` in the pass AND again per HTTP call. In-process, load + resolve once per tick. Behaviorally identical within a tick.
3. **embed-event HTTP layer dropped:** legacy `embed-event` was an HTTP function with a fetch-title-by-id path; its only real callers (`backfill-embeddings`, `tag-event`) import `embedEvent` in-process. Port only the in-process shape; callers supply `{eventId, title, description}`.
4. **Graceful 110s wall budget on the enrichment tick** (checked between rows, like `process-review-queue.ts`), replacing the legacy implicit 150s edge-function kill. Values injectable for tests.
5. **Dead scraper-image path skipped:** legacy `enrichOne` had a scraper re-fetch images path whose `sanitizeImagesForIngest` always returns `[]` (parser images dropped at insert; kept as dead code). Not ported; annotated with provenance comment where the stock-fallback begins.
6. **`ALLOWED_OPENAI_MODELS` ported verbatim although stale** (legacy `generate-parent-tips/handler.ts:25-34`: `gpt-4o-mini, gpt-4o, gpt-4-turbo, gpt-4.1-nano, gpt-4.1-mini, gpt-4.1, gpt-5-mini, gpt-5`). The DB-seeded default `parent-tips` model is `gpt-5.4-nano`, which is NOT in this set — so prod actually runs `DEFAULT_OPENAI_MODEL="gpt-4.1-nano"`. **Keep the bug for U33 parity**; fixing it changes prod LLM behavior at cutover. Code comment must say exactly this. (Post-cutover follow-up: derive allowlist from `approved_ai_models`.)

Known legacy facts that are NOT deviations (encode as-is):
- No claim locks anywhere: candidate selection is plain `SELECT ... ORDER BY last_enrichment_attempt_at ASC NULLS FIRST`; overlap tolerated; rotation via attempt-timestamp bump.
- Embeddings do NOT route via `ai_feature_config` (its CHECK constraint has no `embeddings` feature). Hardcoded `text-embedding-3-small` / 1536 dims / `OPENAI_API_KEY` / `https://api.openai.com/v1/embeddings`.
- `backfill-embeddings` has **no scheduler in the legacy repo** (tag-event embeds inline; the backfill is a manually-invoked catch-up sweep). Port the worker; whether/how to schedule it is a pg-boss-registration-step decision, not this slice's.

---

### Task 1: Enrichment RPC fixture + schema reconciliation + smoke tests

**Files:**
- Create: `test/integration/sql/event_enrichment_rpcs.sql`
- Modify: `test/integration/catalog.ts` (event_image_attributions ~:153-167; events ~:71-107)
- Modify: `test/integration/ingestion-catalog.ts` (`ensureIngestionSchema`)
- Test: `test/integration/enrichment-rpcs.integration.test.ts`

**Interfaces:** Produces: 10 RPCs callable in the disposable DB (private + public pairs): `list_events_needing_enrichment`, `backfill_image_enrichment_in_scope`, `update_event_enrichment`, `mark_event_enrichment_attempt`, `upsert_event_image_attribution_with_enrichment`, `list_pending_unsplash_download_tracking`, `mark_unsplash_download_tracking_result`, `list_events_needing_attribution_backfill`, `list_events_needing_parent_tips`, `update_event_parent_tips`. Later tasks (8) call these via the repository.

- [ ] **Step 1: Extract verbatim SQL.** Sources (backend repo, latest version per function — re-verify "latest wins" by scanning for later `CREATE OR REPLACE` before copying):
  - `list_events_needing_enrichment` → `supabase/migrations/20260601006000_enrichment_images_and_rpc_cleanup.sql:1983-2111`
  - `backfill_image_enrichment_in_scope` → `20260601004000_llm_review_and_enrichment.sql:2290-2377`
  - `update_event_enrichment` → `20260601004000_...:2381-2435`
  - `mark_event_enrichment_attempt` → `20260601004000_...:2440-2463`
  - `upsert_event_image_attribution_with_enrichment` → `20260601006000_...:1036-1169`
  - `list_pending_unsplash_download_tracking` → `20260601006000_...:1178-1221`
  - `mark_unsplash_download_tracking_result` → `20260601006000_...:1226-1272`
  - `list_events_needing_attribution_backfill` → `20260601006000_...:1432-1478`
  - `list_events_needing_parent_tips` → `20260601006000_...:550-626`
  - `update_event_parent_tips` → `20260601006000_...:629-677`

  Header comment format: copy the style of `test/integration/sql/event_llm_review_queue_rpcs.sql:1-13` (per-function source migration + lines + what was trimmed). Strip only GRANT/REVOKE/COMMENT/RLS. Keep `private.` + `public.` wrapper pairs and `SET search_path = ''`.
- [ ] **Step 2: Reconcile catalog schema.** The RPCs reference columns missing from the disposable catalog. Extract the latest legacy DDL for `event_image_attributions` (search `20260601004000`/`20260601006000` for `CREATE TABLE ... event_image_attributions` + subsequent `ALTER TABLE`s) and replace the definition at `test/integration/catalog.ts:154-167`. Must end up including at minimum: `unsplash_download_location`, `download_tracking_status` (default `'pending'`), `download_tracking_attempts` (default 0), `download_tracking_next_attempt_at`, `download_tracked_at`, `download_tracking_last_error`, the `pexels_*`/`pixabay_*` columns (exact names from legacy DDL), and `UNIQUE (event_id, image_url)` (required by the upsert RPC's `ON CONFLICT`). Likewise verify `events` has every column the fixtures touch: `last_enrichment_attempt_at`, `is_featured`, `admin_locked_fields`, `llm_review_decision`, `parent_tips`, `parent_tips_generated_at`, `parent_tips_provider`, `parent_tips_model`, `parent_tips_prompt_version` — add any missing ones from legacy DDL (check `test/integration/sql/events_enriched.sql` first; some already exist).
- [ ] **Step 3: Wire fixture into `ensureIngestionSchema`** in `test/integration/ingestion-catalog.ts`, following the existing execute-order list (after the review-queue fixture). Do NOT wire `list_events_needing_embeddings` here (Task 2; needs pgvector).
- [ ] **Step 4: Write failing smoke tests** in `test/integration/enrichment-rpcs.integration.test.ts` (pattern: `test/integration/review-queue-rpcs.integration.test.ts`; remember the FK gotcha — seed real `cities` + `events` rows). Cover at minimum:
  - `list_events_needing_enrichment`: returns event with NULL coords + geocodable address (`needs_coords=true`); excludes event whose address/venue has no geocodable pattern; treats city-centroid-equal coords as needing coords; respects `admin_locked_fields` (`latitude`/`longitude`/`images`); orders `last_enrichment_attempt_at ASC NULLS FIRST`.
  - `backfill_image_enrichment_in_scope`: only `status='published'` + (`is_featured` OR starts within 30 days) + empty images; `needs_coords` always false.
  - `update_event_enrichment`: skips locked fields; NULL params preserve existing values; empty images array preserves existing; bumps `last_enrichment_attempt_at` + `updated_at`.
  - `mark_event_enrichment_attempt`: bumps timestamp only.
  - `upsert_event_image_attribution_with_enrichment`: writes coords+images then inserts attribution row with `download_tracking_status='pending'`; returns NULL (no attribution) when images locked or image_url not in images array; raises `P0002` for missing event; conflict path preserves `download_tracking_status` once `download_tracked_at` set.
  - `list_pending_unsplash_download_tracking` + `mark_unsplash_download_tracking_result`: pending→succeeded sets `download_tracked_at`; failure increments attempts and sets `next_attempt_at` per backoff `LEAST(1440, GREATEST(5, (attempts+1)*15))` minutes; `P0002` on missing id.
  - `list_events_needing_attribution_backfill`: only published events whose `images->>0` is an `images.unsplash.com` URL with no attribution row.
  - `list_events_needing_parent_tips`: requires `parent_tips IS NULL`, `status='published'`, review decision NULL-or-approve; returns tags ordered by confidence.
  - `update_event_parent_tips`: writes all five fields + bumps `last_enrichment_attempt_at`.
- [ ] **Step 5: Run** `pnpm vitest run --config vitest.integration.config.mts test/integration/enrichment-rpcs.integration.test.ts` → expect FAIL before fixture wiring, PASS after. Then full `pnpm test:integration` (no regressions in existing suites from the catalog change).
- [ ] **Step 6: Commit** — `U29: enrichment RPC fixtures, catalog reconciliation, smoke tests`

### Task 2: `list_events_needing_embeddings` fixture (pgvector layer)

**Files:**
- Create: `test/integration/sql/list_events_needing_embeddings.sql`
- Test: extend `test/integration/enrichment-rpcs.integration.test.ts` (or a small separate file if the pgvector layering makes that cleaner — follow how `classification.repository.integration.test.ts` layers `event_embeddings_similarity.sql`)

**Interfaces:** Produces: `public.list_events_needing_embeddings(p_limit int DEFAULT 50)` in tests that layer the pgvector fixture. Task 8's repository test consumes it.

- [ ] **Step 1: Extract verbatim** from backend `supabase/migrations/20260610190000_list_events_needing_embeddings_rpc.sql:6-19` (single `SECURITY DEFINER` function directly in `public`, no private pair — keep that shape). It LEFT JOINs `event_embeddings`, so this fixture must execute AFTER `event_embeddings_similarity.sql` — do not add it to the base `ensureIngestionSchema`.
- [ ] **Step 2: Failing test:** seed two events, give one an embedding row (copy the hand-built 1536-dim vector helper from `classification.repository.integration.test.ts`), assert only the other is returned, ordered `created_at ASC`, limit clamped to [1,500].
- [ ] **Step 3: Run** the integration file → PASS. **Step 4: Commit** — `U29: list_events_needing_embeddings fixture + smoke test`

### Task 3: embeddings client + `embedEvent`

**Files:**
- Modify: `src/pipeline/llm-openai.ts` (add `postOpenAiEmbedding`)
- Create: `src/pipeline/enrichment/embed-event.ts`
- Test: `src/pipeline/enrichment/embed-event.test.ts`, extend `src/pipeline/llm-openai.test.ts` if it exists (else cover via embed-event tests)

**Interfaces — Produces:**
```ts
// llm-openai.ts
export interface EmbeddingRequestOptions {
  baseUrl: string          // legacy: "https://api.openai.com/v1"
  apiKey: string
  model: string
  input: string
  dimensions: number
  timeoutMs?: number       // legacy: 30_000
  fetchImpl?: typeof fetch
}
export async function postOpenAiEmbedding(options: EmbeddingRequestOptions): Promise<number[]>

// embed-event.ts
export const EMBEDDING_MODEL = "text-embedding-3-small"
export const EMBEDDING_DIMENSIONS = 1536
export const MAX_INPUT_CHARS = 2000
export interface EmbedEventDb {
  /** Upsert into public.event_embeddings ON CONFLICT (event_id) — legacy embed-event/handler.ts storeEmbedding. */
  upsertEventEmbedding(eventId: string, embedding: number[], model: string): Promise<void>
}
export interface EmbedEventInput { eventId: string; title: string; description: string | null }
export interface EmbedEventDependencies { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }
export function buildEmbeddingInput(title: string, description: string | null): string
export class EmbedEventUpstreamError extends Error {}
export async function embedEvent(db: EmbedEventDb, input: EmbedEventInput, deps: EmbedEventDependencies): Promise<void>
```

- [ ] **Step 1: Failing unit tests** (fake `fetchImpl` returning canned OpenAI responses; `FakeEmbedEventDb` recording upserts):
```ts
it("builds input as title + blank line + description, truncated to 2000 chars", () => {
  expect(buildEmbeddingInput("T", "D")).toBe("T\n\nD")
  expect(buildEmbeddingInput("T", null)).toBe("T")
  expect(buildEmbeddingInput("T", "x".repeat(3000)).length).toBe(2000)
})
it("posts model/input/dimensions and upserts the validated 1536-dim vector", async () => { /* assert request body {model:"text-embedding-3-small", input, dimensions:1536}; db.upserts[0] = {eventId, embedding, model} */ })
it("throws EmbedEventUpstreamError on non-2xx with body truncated to 200 chars", async () => { /* 500 + long body */ })
it("throws when the response vector length is not 1536", async () => { /* 3-dim vector */ })
```
  Match exact truncation/joining behavior against legacy `embed-event/handler.ts` (`buildEmbeddingInput`, lines ~40-56; `generateEmbedding` lines 58-98) — port those bodies, adapting Deno fetch idioms to the repo's `fetchImpl` convention (see `stock-images.ts` for the pattern).
- [ ] **Step 2: Run** `pnpm vitest run src/pipeline/enrichment/embed-event.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `pnpm check`.
- [ ] **Step 5: Commit** — `U29: OpenAI embeddings client + embedEvent behind EmbedEventDb seam`

### Task 4: `backfill-embeddings` worker

**Files:**
- Create: `src/pipeline/enrichment/process-embeddings-backfill.ts`
- Test: `src/pipeline/enrichment/process-embeddings-backfill.test.ts`

**Interfaces — Consumes:** `embedEvent`, `EmbedEventDb` (Task 3). **Produces:**
```ts
export interface EmbeddingsBackfillDb extends EmbedEventDb {
  /** public.list_events_needing_embeddings(p_limit) */
  listEventsNeedingEmbeddings(limit: number): Promise<Array<{ id: string; title: string | null; description: string | null }>>
}
export interface EmbeddingsBackfillSummary { totalFound: number; processed: number; failed: number; skipped: number; durationMs: number }
export interface EmbeddingsBackfillDependencies {
  apiKey: string
  batchSize?: number        // legacy BATCH_SIZE = 50
  delayMs?: number          // legacy DELAY_BETWEEN_ITEMS_MS = 50
  budgetMs?: number         // legacy BUDGET_MS = 110_000
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  fetchImpl?: typeof fetch
}
export async function processEmbeddingsBackfill(db: EmbeddingsBackfillDb, deps: EmbeddingsBackfillDependencies): Promise<EmbeddingsBackfillSummary>
```

- [ ] **Step 1: Failing unit tests** with `FakeEmbeddingsBackfillDb` (port semantics from legacy `backfill-embeddings/index.ts:48-140`): skips blank/whitespace titles (counted `skipped`); a throwing `embedEvent` increments `failed` and continues; injected `sleep` called with `delayMs` between items; injected `now` advancing past `budgetMs` stops the loop early; one batch only, no self-loop; summary fields exact.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS + `pnpm check`.**
- [ ] **Step 5: Commit** — `U29: backfill-embeddings worker`

### Task 5: parent-tips port

**Files:**
- Create: `src/pipeline/enrichment/parent-tips-prompt.ts`, `src/pipeline/enrichment/generate-parent-tips.ts`
- Test: `src/pipeline/enrichment/generate-parent-tips.test.ts`

**Interfaces — Consumes:** `resolveSharedLlmConfig` (`llm-config.ts:67`), `postOpenAiChatCompletion` (`llm-openai.ts:51`). **Produces:**
```ts
// parent-tips-prompt.ts — verbatim port of legacy generate-parent-tips/prompt.ts
export const LLM_PARENT_TIPS_PROMPT_VERSION = "parent-tips-v1"
export const PARENT_TIP_CATEGORIES = ["arrival", "bring", "behavior", "timing", "weather", "accessibility"] as const
export type ParentTipCategory = (typeof PARENT_TIP_CATEGORIES)[number]
export function buildParentTipsSystemPrompt(): string
export function buildParentTipsUserPrompt(candidate: ParentTipsCandidate): string  // <event_data> wrapper, title ≤500 / description ≤2000 chars

// generate-parent-tips.ts
export interface ParentTipsCandidate {
  eventId: string; title: string; description: string | null
  ageMin: number | null; ageMax: number | null; isOutdoor: boolean | null
  venueName: string | null; startDatetime: string | null; tags: string[]
}
export interface ParentTip { category: ParentTipCategory; tip: string }
export interface ParentTipsDb {
  /** SELECT cfg.model_id, models.provider, cfg.enabled FROM public.ai_feature_config cfg LEFT JOIN public.approved_ai_models models ON models.id = cfg.model_id WHERE cfg.feature = 'parent-tips' — mirrors ClassificationRepository.loadTagFeatureConfig (classification.repository.ts:108). */
  loadParentTipsFeatureConfig(): Promise<{ modelId: string | null; provider: string | null; enabled: boolean } | null>
  /** private.list_events_needing_parent_tips(p_limit) */
  listEventsNeedingParentTips(limit: number): Promise<ParentTipsCandidate[]>
  /** private.update_event_parent_tips(...) */
  updateEventParentTips(eventId: string, tips: ParentTip[], provider: string, model: string, promptVersion: string): Promise<void>
  /** private.mark_event_enrichment_attempt(p_event_id) */
  markEnrichmentAttempt(eventId: string): Promise<void>
}
export interface ParentTipsLlmConfig { provider: SharedLlmProvider; model: string; baseUrl: string; apiKey: string | null; enabled: boolean; configured: boolean }
export function resolveParentTipsAiConfig(dbConfig: { modelId: string | null; provider: string | null; enabled: boolean } | null, env?: EnvReader): ParentTipsLlmConfig
export type GenerateParentTipsResult =
  | { status: "generated"; tips: ParentTip[]; provider: string; model: string }
  | { status: "failed"; error: string }
export async function generateParentTipsForEvent(db: ParentTipsDb, candidate: ParentTipsCandidate, config: ParentTipsLlmConfig, deps?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<GenerateParentTipsResult>
```
`generateParentTipsForEvent` assumes config is enabled+configured (the pass in Task 7 gates on that before iterating — see deviations 1–2). On `"generated"` it has already called `updateEventParentTips`; on `"failed"` it has made no DB writes (the caller decides whether to mark the attempt, matching the legacy caller split).

- [ ] **Step 1: Port the prompt verbatim** from legacy `generate-parent-tips/prompt.ts` (89 lines): categories, one-sentence-<25-words rule, JSON-only, the prompt-injection guard treating `<event_data>` as untrusted. Same untrusted-delimiter treatment as the review port (deviation #3 in the next-steps doc) — legacy parent-tips already had it, so this is straight fidelity.
- [ ] **Step 2: Failing unit tests** (fake provider via `fetchImpl` or by porting the provider-seam style of `event-review/provider.ts` — pick whichever matches `generateWithLlm`'s port cleanest; legacy: `handler.ts:218-283`):
  - `resolveParentTipsAiConfig`: DB `gpt-4.1-mini` (in allowlist) → used; DB `gpt-5.4-nano` (NOT in allowlist) → falls back to `gpt-4.1-nano` (this test's name must reference deviation #6); `enabled:false` → `configured:false`; provider `ollama` needs no apiKey.
  - Generation: openai path sends `temperature: 0.2` + strict JSON-schema `response_format` (port `PARENT_TIPS_JSON_SCHEMA` from `handler.ts`); ollama path sends `{type:"json_object"}` + `reasoning_effort:"none"`; tips filtered to allowed categories, deduped by category, capped at 3; zero valid tips → `{status:"failed"}` with no `updateEventParentTips` call; success calls `updateEventParentTips` with `LLM_PARENT_TIPS_PROMPT_VERSION`.
- [ ] **Step 3: Run → FAIL. Step 4: Implement** (port `handler.ts:88-111` config load shape into the seam doc-comment, `resolveAiConfig` → `resolveParentTipsAiConfig` on top of `resolveSharedLlmConfig` with `DEFAULT_OPENAI_MODEL="gpt-4.1-nano"` and the verbatim allowlist). **Step 5: Run → PASS + `pnpm check`.**
- [ ] **Step 6: Commit** — `U29: parent-tips generation port (prompt, config routing, LLM call)`

### Task 6: enrichment backfill worker — claim + enrichOne

**Files:**
- Create: `src/pipeline/enrichment/process-enrichment-backfill.ts`
- Test: `src/pipeline/enrichment/process-enrichment-backfill.test.ts`

**Interfaces — Consumes:** `geocodeViaNominatim`, `buildGeocodeQuery` (geocode.ts), `findFallbackImage`, `StockImageProviderKeys` (stock-images.ts), `ParentTipsDb` (Task 5). **Produces:**
```ts
export interface EnrichmentCandidate {
  eventId: string; title: string; description: string | null
  venueName: string | null; address: string | null; cityId: string | null
  sourceId: string | null; sourceUrl: string | null
  needsCoords: boolean; needsImages: boolean
  adminLockedFields: string[]; tags: string[]
}
export interface UnsplashAttributionUpsert { /* exact param list of upsert_event_image_attribution_with_enrichment: eventId, latitude, longitude, images, imageUrl, unsplashPhotoId, photographerName, photographerUsername, photographerProfileUrl, photoUrl, downloadLocation, matchedTag */ }
export interface ProviderImageAttributionUpsert { eventId: string; imageUrl: string; provider: "pexels" | "pixabay"; matchedTag: string | null; /* + the pexels_*/pixabay_* fields from the legacy direct upsert — copy exact set from backfill-event-enrichment/index.ts */ }
export interface EnrichmentDb extends ParentTipsDb {
  listEventsNeedingEnrichment(limit: number): Promise<EnrichmentCandidate[]>
  listImageEnrichmentInScope(limit: number): Promise<EnrichmentCandidate[]>
  /** SELECT name, state FROM public.cities WHERE id = $1 — legacy fetched city context for buildGeocodeQuery, cached per tick. */
  getCityContext(cityId: string): Promise<{ name: string; state: string | null } | null>
  updateEventEnrichment(eventId: string, latitude: number | null, longitude: number | null, images: string[] | null): Promise<void>
  upsertUnsplashAttributionWithEnrichment(params: UnsplashAttributionUpsert): Promise<string | null>
  /** Direct upsert into event_image_attributions ON CONFLICT (event_id, image_url) — legacy did this client-side for pexels/pixabay, no RPC exists. */
  upsertProviderImageAttribution(params: ProviderImageAttributionUpsert): Promise<void>
  listPendingUnsplashTracking(limit: number): Promise<Array<{ attributionId: string; eventId: string; imageUrl: string; downloadLocation: string; attempts: number }>>
  markUnsplashTrackingResult(attributionId: string, success: boolean, error?: string): Promise<void>
  listEventsNeedingAttributionBackfill(limit: number): Promise<Array<{ eventId: string; imageUrl: string }>>
}
export interface EnrichOneOutcome { coordsSet: boolean; imagesSet: boolean; provider: StockProvider | null; attempted: boolean }
export async function enrichOne(db: EnrichmentDb, candidate: EnrichmentCandidate, deps: EnrichmentTickDependencies): Promise<EnrichOneOutcome>
export async function claimEnrichmentBatch(db: EnrichmentDb, batchSize: number): Promise<EnrichmentCandidate[]>  // two-pass claim + dedupe
```
`EnrichmentTickDependencies` (shared with Task 7): `{ providerKeys: StockImageProviderKeys; unsplashAccessKey?: string; parentTipsEnv?: EnvReader; geocode?: typeof geocodeViaNominatim; findImage?: typeof findFallbackImage; trackDownload?: typeof trackUnsplashDownload; lookupPhoto?: typeof lookupUnsplashPhotoFromUrl; fetchImpl?: typeof fetch; batchSize?: number /* 25 */; parentTipsBatch?: number /* 8 */; attributionBackfillBatch?: number /* 10 */; trackingBatch?: number /* 25 */; budgetMs?: number /* 110_000 */; now?: () => number }` — every network helper injectable, defaulting to the real module functions.

Port source: legacy `backfill-event-enrichment/index.ts:106-388` (enrichOne), `:27,541-547` (batch split + dedupe). Copy exact constants and the exact geocode fallback-tier construction (full query → venue-branch split on last comma → venue-only without city), including the explicit *absence* of a city-centroid fallback (keep the legacy comment explaining queue starvation). Unsplash success path: `upsertUnsplashAttributionWithEnrichment` → `trackDownload` → `markUnsplashTrackingResult`. Pexels/pixabay path: `updateEventEnrichment` → `upsertProviderImageAttribution`. Nothing-changed path: `markEnrichmentAttempt`.

- [ ] **Step 1: Failing unit tests** with `FakeEnrichmentDb` (in-memory; records every call in order) and stub geocode/findImage:
  - claim: 25 → two 12-row claims, deduped by eventId, legacy-list first.
  - needs_coords + geocode hit → `updateEventEnrichment(lat, lng, null)`; geocode miss on all tiers with no image need → `markEnrichmentAttempt` only.
  - geocode tier fallback order (assert the query strings passed to the stubbed geocode, built via real `buildGeocodeQuery` with city context from `getCityContext`).
  - needs_images + tags, `findImage` returns unsplash result → unsplash RPC path + tracking calls, and NOT `updateEventEnrichment`; pexels result → `updateEventEnrichment` + `upsertProviderImageAttribution`.
  - needs_images with zero tags → no `findImage` call, falls through to attempt-mark.
  - row-level throw → error counted, loop continues (no rethrow).
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS + `pnpm check`.**
- [ ] **Step 5: Commit** — `U29: enrichment backfill claim + enrichOne behind EnrichmentDb seam`

### Task 7: enrichment backfill worker — auxiliary passes + tick orchestration

**Files:**
- Modify: `src/pipeline/enrichment/process-enrichment-backfill.ts`
- Test: extend `src/pipeline/enrichment/process-enrichment-backfill.test.ts`

**Interfaces — Consumes:** Task 6's `enrichOne`/`claimEnrichmentBatch`, Task 5's `generateParentTipsForEvent`/`resolveParentTipsAiConfig`. **Produces:**
```ts
export interface EnrichmentTickSummary {
  claimed: number; coordsSet: number; imagesSet: number; attemptsMarked: number; errors: number
  tracking: { processed: number; succeeded: number; failed: number }
  attributionBackfill: { processed: number; upserted: number; errors: number }
  parentTips: { enabled: boolean; generated: number; errors: number }
  durationMs: number; stoppedEarly: boolean
}
export async function runEnrichmentTick(db: EnrichmentDb, deps: EnrichmentTickDependencies): Promise<EnrichmentTickSummary>
```
Port sources: `index.ts:390-423` (`runPendingUnsplashTrackingPass`), `:439-499` (`runUnsplashAttributionBackfillPass`, uses `lookupPhoto` + attribution upsert), `parent-tips-pass.ts:23-110` (config gate → `listEventsNeedingParentTips(8)` → per-row generate; `not-configured` → count error and **break**; other failure → `markEnrichmentAttempt` + count; success → count `generated`), `:501-678` (tick order: main batch → tracking pass → attribution backfill → parent-tips pass → summary). Budget check between rows per deviation #4; when tripped, remaining passes still-unrun are skipped and `stoppedEarly: true`.

- [ ] **Step 1: Failing unit tests:** tracking pass marks success/failure per stubbed `trackDownload`; attribution backfill upserts from stubbed `lookupPhoto` and counts a null lookup as error; parent-tips pass: disabled config → `{enabled:false}` and zero list calls; `not-configured` → break after first row (assert only one generate attempt against a 3-row list); generation failure → `markEnrichmentAttempt` called for that row, pass continues; budget exhaustion mid-main-batch → `stoppedEarly:true`, aux passes skipped.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS + `pnpm check`.**
- [ ] **Step 5: Commit** — `U29: enrichment tick orchestration (tracking, attribution backfill, parent-tips passes)`

### Task 8: `EnrichmentRepository` + integration tests

**Files:**
- Create: `src/pipeline/enrichment/enrichment.repository.ts`
- Test: `test/integration/enrichment.repository.integration.test.ts`

**Interfaces — Consumes:** every seam above; `DbService`; fixtures from Tasks 1–2. **Produces:**
```ts
@Injectable()
export class EnrichmentRepository implements EnrichmentDb, EmbeddingsBackfillDb {
  constructor(private readonly db: DbService) {}
  // one method per seam operation; module-level const *_SQL strings following
  // review.repository.ts conventions exactly (call the ported RPCs the same way
  // it does; doc-comment each with the legacy RPC name + parameter order).
}
```
Notes: `loadParentTipsFeatureConfig` mirrors `classification.repository.ts:108-113` with `feature = 'parent-tips'`. `upsertProviderImageAttribution` is direct SQL (`INSERT ... ON CONFLICT (event_id, image_url) DO UPDATE` — column set byte-checked against legacy `index.ts`'s supabase upsert). `upsertEventEmbedding` mirrors legacy `storeEmbedding` (`embed-event/handler.ts:100-120`): vector serialized `[v1,v2,...]` and cast, `ON CONFLICT (event_id)`.

- [ ] **Step 1: Failing integration tests** (pattern: `test/integration/review.repository.integration.test.ts`; seed `cities`+`events`; layer pgvector fixtures for the embeddings methods): every repository method round-trips against the real RPCs — claim lists return mapped camelCase rows; `updateEventEnrichment` honors locks; unsplash upsert returns attribution id; tracking mark applies backoff; `loadParentTipsFeatureConfig` returns the joined row (seed `approved_ai_models` + `ai_feature_config`; check whether the base catalog already creates these tables for the tagging tests — reuse); `upsertEventEmbedding` then `listEventsNeedingEmbeddings` excludes the embedded event. Finish with one composed test: seed one geocodable-no-image event, run `runEnrichmentTick(repository, deps-with-stubbed-network)`, assert coords + image + attribution written and summary counts.
- [ ] **Step 2: Run** `pnpm vitest run --config vitest.integration.config.mts test/integration/enrichment.repository.integration.test.ts` → FAIL. **Step 3: Implement. Step 4: Run → PASS**, then full `pnpm test:integration`.
- [ ] **Step 5: Commit** — `U29: EnrichmentRepository implementing enrichment/embeddings/parent-tips seams`

### Task 9: module registration, env docs, gates, handoff

**Files:**
- Modify: `src/pipeline/pipeline.module.ts` (add `EnrichmentRepository` to `providers` + `exports`; do NOT add any `OnModuleInit` service — no scheduling in this slice)
- Modify: `.env.example` (add any of `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY` not already present; `OPENAI_API_KEY` already documented)
- Modify: `docs/plans/2026-08-16-002-nestjs-backend-rewrite-plan.md` §U29 (mark enrichment slice landed; remaining = pg-boss registration) and `~/Projects/personal/web/2026-08-23-003-migration-next-steps.md` (strike step 2)

- [ ] **Step 1:** Register + export the repository; boot-smoke via existing app e2e/unit if one exists (match how `ClassificationRepository` registration was verified).
- [ ] **Step 2:** Full gates: `pnpm check`, `pnpm test:integration`, and confirm `openapi.json` unchanged (`git diff --stat` shows no openapi delta).
- [ ] **Step 3:** Update the two plan docs' status lines.
- [ ] **Step 4: Commit** — `U29: register EnrichmentRepository; enrichment slice complete`
- [ ] **Step 5:** Independent review before PR: run Codex in challenge/review mode over the whole branch diff (`/codex` per `codex-delegation` skill), then a final whole-branch self-review. Address findings.
- [ ] **Step 6:** Open PR (live, not draft). **STOP — merge waits for Jacob's explicit in-session go.**

---

## Self-review notes (already applied)

- Spec coverage: master plan §U29 remaining items = "repository implementation + LLM enrichment worker integration" → Tasks 3–8; next-steps step 2's four functions each have a dedicated task; `ai_feature_config` routing covered for parent-tips (the only enrichment feature the DB CHECK constraint supports — `embeddings` is deliberately hardcoded, matching legacy).
- Out of scope (explicitly deferred to next-steps step 3): pg-boss `TagQueueService`/`ReviewQueueService`/enrichment scheduling, `CUTOVER_*` gating, deleting `family-events-app/src/worker/`, and any decision on scheduling `backfill-embeddings`.
- Type consistency: `markEnrichmentAttempt` is declared once in `ParentTipsDb` and inherited by `EnrichmentDb extends ParentTipsDb`; `EmbeddingsBackfillDb extends EmbedEventDb`; `EnrichmentRepository implements EnrichmentDb, EmbeddingsBackfillDb` covers all five interfaces.
