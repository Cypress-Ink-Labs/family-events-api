import { Injectable } from "@nestjs/common"

import { DbService } from "../../db/db.service.js"
import type {
  AdminDecisionRow,
  EventTagRow,
  FindSimilarEventsArgs,
  MemoryContextDb,
  MemoryFeature,
  ReviewAdminDecisionRow,
  ReviewEventRow,
  SimilarEventRow,
} from "../memory-context.js"
import type { EventInputs, TagQueueDb, TagQueueRow } from "./process-tag-queue.js"
import type { TagQueueStatus } from "./queue-policy.js"
import type {
  AvailableTag,
  CityLocationRow,
  CurrentEvent,
  TagAssignmentUpsert,
  TagEventDb,
  TagFeatureConfigRow,
  TagTraceInsert,
} from "./tag-event.js"

// SQL translations of the supabase-js queries and RPC calls the legacy
// tag-event / process-tag-queue / _shared/memory-context edge functions issued
// (U29). The queue RPCs themselves (reap_stuck_tag_queue_rows,
// claim_tag_queue_batch, mark_tag_queue_row_started,
// release_unstarted_tag_queue_rows) stay in the database — the API calls the
// same public wrappers PostgREST exposed to the edge functions, so old and new
// pipelines share one implementation until U18 decommissions the edge
// functions.

const MEMORY_FEATURE_FLAG_SQL = `
SELECT enabled
FROM public.ai_feature_config
WHERE feature = $1
`

// public.find_similar_events declares its parameters positionally as
// (p_embedding extensions.vector(1536), p_limit int, p_threshold float,
// p_exclude_event_id uuid, p_city_id uuid); the call below must match that
// order exactly. The embedding arrives as a pgvector literal string like
// "[0.1,0.2,...]" (assembled by the caller) and needs an explicit cast because
// pg sends parameters untyped and overload resolution would fail without it.
const FIND_SIMILAR_EVENTS_SQL = `
SELECT event_id::text, title, status, cosine_distance, source_id::text, city_id::text
FROM public.find_similar_events(
  $1::extensions.vector(1536),
  $2::int,
  $3::float8,
  $4::uuid,
  $5::uuid
)
`

// tags(slug, name) was a supabase-js embed returning one nested object per row
// (or null when nothing joined); LEFT JOIN + jsonb_build_object keeps that
// nullable nested shape instead of flattening into columns. confidence is
// numeric(4,3), which pg returns as text, so it is cast to float8 to match the
// seam's number type (same idiom as the city centroid read in
// ingestion.repository.ts).
const FETCH_EVENT_TAGS_FOR_EVENTS_SQL = `
SELECT et.event_id::text, et.tag_id::text, et.confidence::float8 AS confidence,
       et.is_manual_override,
       CASE WHEN t.id IS NULL THEN NULL
            ELSE jsonb_build_object('slug', t.slug, 'name', t.name) END AS tags
FROM public.event_tags et
LEFT JOIN public.tags t ON t.id = et.tag_id
WHERE et.event_id = ANY($1::uuid[])
`

// created_at is re-serialized as UTC ISO 8601 because PostgREST returned ISO
// strings to the edge functions while pg's default text format ("2026-06-20
// 14:00:00+00") would silently change what callers observe. Newest-first
// matches the legacy .order("created_at", { ascending: false }).
const FETCH_TAG_DECISIONS_FOR_EVENTS_SQL = `
SELECT event_id::text, decision_type, new_tags, reason,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM public.admin_event_decisions
WHERE event_id = ANY($1::uuid[])
  AND decision_type IN ('tag_edit', 'status_and_tags')
ORDER BY admin_event_decisions.created_at DESC
`

// Same ISO re-serialization rationale as FETCH_TAG_DECISIONS_FOR_EVENTS_SQL.
const FETCH_STATUS_DECISIONS_FOR_EVENTS_SQL = `
SELECT event_id::text, decision_type, new_status, reason,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM public.admin_event_decisions
WHERE decision_type = 'status_change'
  AND event_id = ANY($1::uuid[])
ORDER BY admin_event_decisions.created_at DESC
`

// llm_review_decision is an enum; pg returns enums as their text label, which
// is what the seam's string type expects.
const FETCH_REVIEW_EVENTS_BY_IDS_SQL = `
SELECT id::text, status, llm_review_decision
FROM public.events
WHERE id = ANY($1::uuid[])
`

// approved_ai_models(provider) was an optional supabase-js embed; the LEFT
// JOIN preserves "no matching model row" so this method can apply the legacy
// fallback (provider ?? "openai") at the same place the handler did.
const LOAD_TAG_FEATURE_CONFIG_SQL = `
SELECT cfg.model_id AS "modelId", models.provider AS provider, cfg.enabled
FROM public.ai_feature_config cfg
LEFT JOIN public.approved_ai_models models ON models.id = cfg.model_id
WHERE cfg.feature = 'tagging'
`

// price/latitude/longitude are numeric(10,x): pg returns numeric as text while
// the seam types promise numbers, so they are cast to float8 here (same idiom
// as FETCH_CITY_CENTROID_SQL in ingestion.repository.ts).
const GET_EVENT_FOR_TAGGING_SQL = `
SELECT title, description, price::float8 AS price, is_free, venue_name, address,
       latitude::float8 AS latitude, longitude::float8 AS longitude, city_id::text
FROM public.events
WHERE id = $1::uuid
`

const LIST_AVAILABLE_TAGS_SQL = `
SELECT id::text, slug, name
FROM public.tags
`

// available_tag_slugs/predicted_tags/predicted_fields are jsonb columns;
// parameters are JSON.stringify'd and cast explicitly because pg sends them as
// plain text.
const INSERT_TAG_TRACE_SQL = `
INSERT INTO public.event_ai_traces (
  event_id, source_run_id, trigger_type, provider, model, status, prompt_version,
  input_title, input_description, available_tag_slugs, predicted_tags,
  predicted_fields, reasoning_summary, fallback_reason, processing_ms
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
        $12::jsonb, $13, $14, $15)
`

const LIST_MANUAL_OVERRIDE_TAG_IDS_SQL = `
SELECT tag_id::text
FROM public.event_tags
WHERE event_id = $1::uuid AND is_manual_override = true
`

const DELETE_AUTO_ASSIGNED_TAGS_SQL = `
DELETE FROM public.event_tags
WHERE event_id = $1::uuid AND is_manual_override = false
`

// Legacy upsert(rows, { onConflict: "event_id,tag_id" }): supabase-js defaults
// to ON CONFLICT DO UPDATE over the payload columns — including
// is_manual_override, which the handler always passes as false today but the
// payload type carries. unnest zips the parallel arrays into rows for one
// parameterized statement; EXCLUDED drives the update so a caller passing
// true would upsert an override exactly as supabase-js would have.
const UPSERT_TAG_ASSIGNMENTS_SQL = `
INSERT INTO public.event_tags (event_id, tag_id, confidence, is_manual_override)
SELECT u.event_id, u.tag_id, u.confidence, u.is_manual_override
FROM unnest($1::uuid[], $2::uuid[], $3::float8[], $4::boolean[])
     AS u(event_id, tag_id, confidence, is_manual_override)
ON CONFLICT (event_id, tag_id) DO UPDATE
SET confidence = EXCLUDED.confidence,
    is_manual_override = EXCLUDED.is_manual_override
`

const GET_CITY_LOCATION_SQL = `
SELECT name, state, latitude::float8 AS latitude, longitude::float8 AS longitude
FROM public.cities
WHERE id = $1::uuid
`

// Legacy supabase-js `.update(payload).eq("id", eventId)` wrote ONLY the keys
// present in the payload object; buildEventUpdatePayload (tag-event.ts) always
// includes the six ai_*/age_* columns but adds price/is_free/venue_name/
// latitude/longitude only when they should be filled, deliberately never
// overwriting existing values. Each conditional column therefore becomes
// COALESCE($n, col): the parameter is non-null exactly when the legacy payload
// contained that key (the caller guarantees present keys carry their final
// value — non-null number, is_free=true, non-empty string), otherwise the
// existing column value passes through untouched. Keys outside this fixed set
// are ignored; the payload is produced internally by tag-event.ts.
const UPDATE_EVENT_AFTER_TAGGING_SQL = `
UPDATE public.events
SET ai_confidence = $2,
    ai_tag_provider = $3,
    ai_tag_model = $4,
    ai_tag_status = $5,
    age_min = $6,
    age_max = $7,
    price = COALESCE($8::numeric, price),
    is_free = COALESCE($9::boolean, is_free),
    venue_name = COALESCE($10, venue_name),
    latitude = COALESCE($11::numeric, latitude),
    longitude = COALESCE($12::numeric, longitude)
WHERE id = $1::uuid
`

// Queue RPCs (public wrappers over the private SECURITY DEFINER functions —
// the same surface PostgREST exposed to the edge functions). Queue ids are
// bigint; they are cast to int here because pg returns int8 as text and the
// worker compares ids numerically. The queue would need ~2^31 rows for that
// cast to matter.
const REAP_STUCK_TAG_QUEUE_SQL = `
SELECT public.reap_stuck_tag_queue_rows() AS reaped
`

const CLAIM_TAG_QUEUE_BATCH_SQL = `
SELECT id::int AS id, event_id::text, source_run_id::text, trigger_type, attempt_count
FROM public.claim_tag_queue_batch($1::int)
`

const MARK_TAG_QUEUE_ROW_STARTED_SQL = `
SELECT id::int AS id, event_id::text, source_run_id::text, trigger_type, attempt_count
FROM public.mark_tag_queue_row_started($1::bigint)
`

const RELEASE_UNSTARTED_TAG_QUEUE_ROWS_SQL = `
SELECT public.release_unstarted_tag_queue_rows($1::bigint[])
`

const FETCH_EVENT_INPUTS_SQL = `
SELECT title, description
FROM public.events
WHERE id = $1::uuid
`

const FETCH_EVENT_INPUTS_BULK_SQL = `
SELECT id::text, title, description
FROM public.events
WHERE id = ANY($1::uuid[])
`

// status is the event_tag_queue_status enum, so parameters/literals get
// explicit ::event_tag_queue_status casts. finished_at uses now() rather than
// echoing an app-clock ISO timestamp (matches the source_scrape_queue success
// write in ingestion.repository.ts).
const COMPLETE_TAG_QUEUE_ROW_SQL = `
UPDATE public.event_tag_queue
SET status = $2::public.event_tag_queue_status, finished_at = now(), last_error = NULL
WHERE id = $1::bigint
`

const MARK_TAG_QUEUE_ROW_DEAD_SQL = `
UPDATE public.event_tag_queue
SET status = 'dead'::public.event_tag_queue_status, finished_at = now(), last_error = $2
WHERE id = $1::bigint
`

// next_attempt_at arrives as an ISO string from the worker's backoff ladder;
// written with an explicit ::timestamptz cast.
const SCHEDULE_TAG_QUEUE_RETRY_SQL = `
UPDATE public.event_tag_queue
SET status = 'pending'::public.event_tag_queue_status,
    started_at = NULL,
    next_attempt_at = $2::timestamptz,
    last_error = $3
WHERE id = $1::bigint
`

// count(*) is int8 (pg returns it as text), so it is cast to int — pending-row
// counts are nowhere near 2^31.
const COUNT_PENDING_TAG_QUEUE_ROWS_SQL = `
SELECT count(*)::int AS count
FROM public.event_tag_queue
WHERE status = 'pending'::public.event_tag_queue_status
`

@Injectable()
export class ClassificationRepository implements MemoryContextDb, TagEventDb, TagQueueDb {
  constructor(private readonly db: DbService) {}

  // ── MemoryContextDb ────────────────────────────────────────────────────────

  async getMemoryFeatureFlag(feature: MemoryFeature): Promise<{ enabled: boolean } | null> {
    const rows = await this.db.query<{ enabled: boolean }>(MEMORY_FEATURE_FLAG_SQL, [feature])
    return rows[0] ?? null
  }

  async findSimilarEvents(args: FindSimilarEventsArgs): Promise<SimilarEventRow[]> {
    return this.db.query<SimilarEventRow>(FIND_SIMILAR_EVENTS_SQL, [
      args.embedding,
      args.limit,
      args.threshold,
      args.excludeEventId,
      args.cityId,
    ])
  }

  async fetchEventTagsForEvents(eventIds: string[]): Promise<EventTagRow[]> {
    return this.db.query<EventTagRow>(FETCH_EVENT_TAGS_FOR_EVENTS_SQL, [eventIds])
  }

  async fetchTagDecisionsForEvents(eventIds: string[]): Promise<AdminDecisionRow[]> {
    return this.db.query<AdminDecisionRow>(FETCH_TAG_DECISIONS_FOR_EVENTS_SQL, [eventIds])
  }

  async fetchReviewEventsByIds(eventIds: string[]): Promise<ReviewEventRow[]> {
    return this.db.query<ReviewEventRow>(FETCH_REVIEW_EVENTS_BY_IDS_SQL, [eventIds])
  }

  async fetchStatusDecisionsForEvents(eventIds: string[]): Promise<ReviewAdminDecisionRow[]> {
    return this.db.query<ReviewAdminDecisionRow>(FETCH_STATUS_DECISIONS_FOR_EVENTS_SQL, [eventIds])
  }

  // ── TagEventDb ─────────────────────────────────────────────────────────────

  async loadTagFeatureConfig(): Promise<TagFeatureConfigRow | null> {
    const rows = await this.db.query<{
      modelId: string
      provider: string | null
      enabled: boolean
    }>(LOAD_TAG_FEATURE_CONFIG_SQL)
    const row = rows[0]
    if (!row) return null
    // Legacy: `row.approved_ai_models?.provider ?? "openai"` on the embed.
    return { modelId: row.modelId, provider: row.provider ?? "openai", enabled: row.enabled }
  }

  async getEventForTagging(eventId: string): Promise<CurrentEvent | null> {
    const rows = await this.db.query<CurrentEvent>(GET_EVENT_FOR_TAGGING_SQL, [eventId])
    return rows[0] ?? null
  }

  async listAvailableTags(): Promise<AvailableTag[]> {
    return this.db.query<AvailableTag>(LIST_AVAILABLE_TAGS_SQL)
  }

  async insertTagTrace(row: TagTraceInsert): Promise<void> {
    await this.db.query(INSERT_TAG_TRACE_SQL, [
      row.event_id,
      row.source_run_id,
      row.trigger_type,
      row.provider,
      row.model,
      row.status,
      row.prompt_version,
      row.input_title,
      row.input_description,
      JSON.stringify(row.available_tag_slugs),
      JSON.stringify(row.predicted_tags),
      JSON.stringify(row.predicted_fields),
      row.reasoning_summary,
      row.fallback_reason,
      row.processing_ms,
    ])
  }

  async listManualOverrideTagIds(eventId: string): Promise<string[]> {
    const rows = await this.db.query<{ tag_id: string }>(LIST_MANUAL_OVERRIDE_TAG_IDS_SQL, [
      eventId,
    ])
    return rows.map((row) => row.tag_id)
  }

  async deleteAutoAssignedTags(eventId: string): Promise<void> {
    await this.db.query(DELETE_AUTO_ASSIGNED_TAGS_SQL, [eventId])
  }

  async upsertTagAssignments(rows: TagAssignmentUpsert[]): Promise<void> {
    await this.db.query(UPSERT_TAG_ASSIGNMENTS_SQL, [
      rows.map((row) => row.event_id),
      rows.map((row) => row.tag_id),
      rows.map((row) => row.confidence),
      rows.map((row) => row.is_manual_override),
    ])
  }

  async getCityLocation(cityId: string): Promise<CityLocationRow | null> {
    const rows = await this.db.query<CityLocationRow>(GET_CITY_LOCATION_SQL, [cityId])
    return rows[0] ?? null
  }

  async updateEventAfterTagging(eventId: string, payload: Record<string, unknown>): Promise<void> {
    // See UPDATE_EVENT_AFTER_TAGGING_SQL: absent keys mean "leave untouched",
    // present keys always carry their final value, so raw pass-through + ?? null
    // reproduces the legacy update-payload semantics exactly.
    await this.db.query(UPDATE_EVENT_AFTER_TAGGING_SQL, [
      eventId,
      payload.ai_confidence,
      payload.ai_tag_provider,
      payload.ai_tag_model,
      payload.ai_tag_status,
      payload.age_min,
      payload.age_max,
      payload.price ?? null,
      payload.is_free ?? null,
      payload.venue_name ?? null,
      payload.latitude ?? null,
      payload.longitude ?? null,
    ])
  }

  // ── TagQueueDb ─────────────────────────────────────────────────────────────

  async reapStuckTagQueueRows(): Promise<number> {
    const rows = await this.db.query<{ reaped: number }>(REAP_STUCK_TAG_QUEUE_SQL)
    return Number(rows[0]?.reaped ?? 0)
  }

  async claimTagQueueBatch(limit: number): Promise<TagQueueRow[]> {
    return this.db.query<TagQueueRow>(CLAIM_TAG_QUEUE_BATCH_SQL, [limit])
  }

  async markTagQueueRowStarted(queueId: number): Promise<TagQueueRow> {
    const rows = await this.db.query<TagQueueRow>(MARK_TAG_QUEUE_ROW_STARTED_SQL, [queueId])
    // The claim transition guarantees the row is 'processing' with a NULL
    // started_at, so the guarded UPDATE always matches exactly one row.
    return (
      rows[0] ?? {
        id: queueId,
        event_id: "",
        source_run_id: null,
        trigger_type: "import",
        attempt_count: 0,
      }
    )
  }

  async releaseUnstartedTagQueueRows(claimedIds: number[]): Promise<void> {
    await this.db.query(RELEASE_UNSTARTED_TAG_QUEUE_ROWS_SQL, [claimedIds])
  }

  async fetchEventInputs(eventId: string): Promise<EventInputs | null> {
    const rows = await this.db.query<{ title: unknown; description: unknown }>(
      FETCH_EVENT_INPUTS_SQL,
      [eventId]
    )
    const row = rows[0]
    if (!row) return null
    // Legacy normalizeEventInputs coerced unknown Supabase fields; title is NOT
    // NULL in the DDL and description is nullable, so String(... ?? "")
    // reproduces it over typed columns.
    return { title: String(row.title ?? ""), description: String(row.description ?? "") }
  }

  async fetchEventInputsBulk(eventIds: string[]): Promise<Map<string, EventInputs>> {
    const inputsById = new Map<string, EventInputs>()
    if (eventIds.length === 0) return inputsById
    try {
      const rows = await this.db.query<{ id: string; title: unknown; description: unknown }>(
        FETCH_EVENT_INPUTS_BULK_SQL,
        [eventIds]
      )
      for (const row of rows) {
        inputsById.set(row.id, {
          title: String(row.title ?? ""),
          description: String(row.description ?? ""),
        })
      }
    } catch {
      // Legacy prefetchEventInputs surfaced a bulk-query failure as an empty
      // Map so every claimed row falls back to its own per-row fetch, keeping
      // the original per-row retry/dead routing on transient read failures.
    }
    return inputsById
  }

  async completeTagQueueRow(rowId: number, status: TagQueueStatus): Promise<void> {
    await this.db.query(COMPLETE_TAG_QUEUE_ROW_SQL, [rowId, status])
  }

  async markTagQueueRowDead(rowId: number, error: string): Promise<void> {
    await this.db.query(MARK_TAG_QUEUE_ROW_DEAD_SQL, [rowId, error])
  }

  async scheduleTagQueueRetry(rowId: number, nextAttemptAt: string, error: string): Promise<void> {
    await this.db.query(SCHEDULE_TAG_QUEUE_RETRY_SQL, [rowId, nextAttemptAt, error])
  }

  async countPendingTagQueueRows(): Promise<number> {
    const rows = await this.db.query<{ count: number }>(COUNT_PENDING_TAG_QUEUE_ROWS_SQL)
    return Number(rows[0]?.count ?? 0)
  }
}
