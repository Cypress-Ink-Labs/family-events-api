import { Injectable } from "@nestjs/common"

import { DbService } from "../../db/db.service.js"
import { ClassificationRepository } from "../classification/classification.repository.js"
import type {
  AdminDecisionRow,
  EventTagRow,
  FindSimilarEventsArgs,
  MemoryFeature,
  ReviewAdminDecisionRow,
  ReviewEventRow,
  SimilarEventRow,
} from "../memory-context.js"
import type {
  ApplyEventDecisionInput,
  EventLlmReviewQueueRow,
  EventReviewRow,
  ReviewQueueDb,
  ReviewTraceInsert,
} from "./process-review-queue.js"

// SQL translations of the supabase-js queries and public RPC calls used by
// the legacy process-event-review-queue worker. Queue ids are bigint in the
// schema but are cast to int because the worker seam uses numbers.

const REAP_STUCK_REVIEW_QUEUE_ROWS_SQL = `
SELECT public.reap_stuck_event_llm_review_rows() AS reaped
`

// next_attempt_at is re-serialized as UTC ISO 8601 because PostgREST returned
// ISO strings while DbService intentionally leaves timestamptz values as pg
// text. The worker contract retains the legacy string shape.
const CLAIM_REVIEW_QUEUE_BATCH_SQL = `
SELECT id::int AS id, event_id::text, source_id::text, source_run_id::text,
       trigger_type, status::text AS status, attempt_count, max_attempts,
       to_char(next_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         AS next_attempt_at
FROM public.claim_event_llm_review_queue_batch($1::int)
`

const MARK_REVIEW_QUEUE_ROW_STARTED_SQL = `
SELECT id::int AS id, event_id::text, source_id::text, source_run_id::text,
       trigger_type, status::text AS status, attempt_count, max_attempts,
       to_char(next_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         AS next_attempt_at
FROM public.mark_event_llm_review_queue_row_started($1::bigint)
`

const RELEASE_UNSTARTED_REVIEW_QUEUE_ROWS_SQL = `
SELECT public.release_unstarted_event_llm_review_rows($1::bigint[])
`

const MARK_REVIEW_QUEUE_ROW_SUCCEEDED_SQL = `
UPDATE public.event_llm_review_queue
SET status = 'succeeded'::public.llm_event_review_queue_status,
    finished_at = now(),
    last_error = NULL,
    updated_at = now()
WHERE id = $1::bigint
`

const MARK_REVIEW_QUEUE_ROW_DEAD_SQL = `
UPDATE public.event_llm_review_queue
SET status = 'dead'::public.llm_event_review_queue_status,
    finished_at = now(),
    last_error = left($2, 1000),
    updated_at = now()
WHERE id = $1::bigint
  AND status = 'processing'::public.llm_event_review_queue_status
  AND finished_at IS NULL
`

const SCHEDULE_REVIEW_QUEUE_RETRY_SQL = `
UPDATE public.event_llm_review_queue
SET status = 'retrying'::public.llm_event_review_queue_status,
    started_at = NULL,
    next_attempt_at = $2::timestamptz,
    last_error = left($3, 1000),
    updated_at = now()
WHERE id = $1::bigint
  AND status = 'processing'::public.llm_event_review_queue_status
  AND finished_at IS NULL
`

const LOAD_REVIEW_EVENT_SQL = `
SELECT id::text, status::text AS status, title, description,
       to_char(start_datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         AS start_datetime,
       CASE WHEN end_datetime IS NULL THEN NULL
            ELSE to_char(end_datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       END AS end_datetime,
       timezone, venue_name, address, source_name, source_url,
       llm_review_status::text AS llm_review_status,
       llm_review_decision::text AS llm_review_decision
FROM public.events
WHERE id = $1::uuid
`

const INSERT_REVIEW_TRACE_SQL = `
INSERT INTO public.event_llm_review_traces (
  event_id, queue_id, source_id, source_run_id, provider, model, prompt_version,
  status, model_decision, applied_decision, confidence, reason, flags,
  suggested_category, normalized_title, raw_response, error_code, error_message,
  input_snapshot, processing_ms
)
VALUES (
  $1::uuid, $2::bigint, $3::uuid, $4::uuid, $5, $6, $7,
  $8::public.llm_event_review_status,
  $9::public.llm_event_review_decision,
  $10::public.llm_event_review_decision,
  $11::numeric, $12, $13::text[], $14, $15, $16::jsonb, $17, $18,
  $19::jsonb, $20::integer
)
`

// Parameter order exactly matches public.apply_event_llm_review_decision:
// p_queue_id through p_processing_ms (20 parameters). The RPC owns the event
// transition, success trace, tag-queue enqueue, and review-queue completion in
// one transaction; callers must not separately insert a success trace.
const APPLY_EVENT_DECISION_SQL = `
SELECT public.apply_event_llm_review_decision(
  $1::bigint, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
  $8::public.llm_event_review_status,
  $9::public.llm_event_review_decision,
  $10::public.llm_event_review_decision,
  $11::numeric, $12, $13::text[], $14, $15, $16::jsonb, $17, $18,
  $19::jsonb, $20::integer
) AS applied
`

const SHOULD_AUTO_REJECT_SOURCE_SQL = `
SELECT public.should_auto_reject_source($1::uuid) AS should_reject
`

// event_embeddings is deliberately absent from the disposable integration
// catalog because its embedding column requires pgvector. Production has the
// table and ::text preserves the JSON-compatible vector representation used
// by the legacy worker.
const FETCH_EVENT_EMBEDDING_SQL = `
SELECT embedding::text AS embedding
FROM public.event_embeddings
WHERE event_id = $1::uuid
`

const FETCH_EVENT_CITY_ID_SQL = `
SELECT city_id::text
FROM public.events
WHERE id = $1::uuid
`

// Legacy buildReviewQueueDeps loaded this joined row once per batch before
// resolveLlmReviewConfig. A missing row falls back to env configuration.
const LOAD_EVENT_REVIEW_FEATURE_CONFIG_SQL = `
SELECT cfg.model_id AS model, cfg.enabled, models.provider
FROM public.ai_feature_config cfg
LEFT JOIN public.approved_ai_models models ON models.id = cfg.model_id
WHERE cfg.feature = 'event-review'
`

function traceInputSnapshot(event: EventReviewRow): Record<string, unknown> {
  return {
    title: event.title,
    start_datetime: event.start_datetime,
    source_name: event.source_name,
    source_url: event.source_url,
  }
}

@Injectable()
export class ReviewRepository implements ReviewQueueDb {
  private readonly memory: ClassificationRepository

  constructor(private readonly db: DbService) {
    this.memory = new ClassificationRepository(db)
  }

  // ── ReviewQueueDb ─────────────────────────────────────────────────────────

  async loadEventReviewFeatureConfig(): Promise<{
    model: string
    enabled: boolean
    provider: string | null
  } | null> {
    const rows = await this.db.query<{
      model: string
      enabled: boolean
      provider: string | null
    }>(LOAD_EVENT_REVIEW_FEATURE_CONFIG_SQL)
    return rows[0] ?? null
  }

  async reapStuckReviewQueueRows(): Promise<number> {
    const rows = await this.db.query<{ reaped: number }>(REAP_STUCK_REVIEW_QUEUE_ROWS_SQL)
    return Number(rows[0]?.reaped ?? 0)
  }

  async claimReviewQueueBatch(limit: number): Promise<EventLlmReviewQueueRow[]> {
    return this.db.query<EventLlmReviewQueueRow>(CLAIM_REVIEW_QUEUE_BATCH_SQL, [limit])
  }

  async markReviewQueueRowStarted(queueId: number): Promise<EventLlmReviewQueueRow | null> {
    const rows = await this.db.query<EventLlmReviewQueueRow>(MARK_REVIEW_QUEUE_ROW_STARTED_SQL, [
      queueId,
    ])
    const row = rows[0]
    return row && row.id !== null ? row : null
  }

  async releaseUnstartedReviewQueueRows(claimedIds: number[]): Promise<void> {
    await this.db.query(RELEASE_UNSTARTED_REVIEW_QUEUE_ROWS_SQL, [claimedIds])
  }

  async markReviewQueueRowSucceeded(queueId: number): Promise<void> {
    await this.db.query(MARK_REVIEW_QUEUE_ROW_SUCCEEDED_SQL, [queueId])
  }

  async markReviewQueueRowDead(queueId: number, error: string): Promise<void> {
    await this.db.query(MARK_REVIEW_QUEUE_ROW_DEAD_SQL, [queueId, error])
  }

  async scheduleReviewQueueRetry(
    queueId: number,
    nextAttemptAt: string,
    error: string
  ): Promise<void> {
    await this.db.query(SCHEDULE_REVIEW_QUEUE_RETRY_SQL, [queueId, nextAttemptAt, error])
  }

  async loadReviewEvent(eventId: string): Promise<EventReviewRow | null> {
    const rows = await this.db.query<EventReviewRow>(LOAD_REVIEW_EVENT_SQL, [eventId])
    return rows[0] ?? null
  }

  async insertReviewTrace(params: ReviewTraceInsert): Promise<void> {
    await this.db.query(INSERT_REVIEW_TRACE_SQL, [
      params.eventId,
      params.queueRow.id,
      params.queueRow.source_id,
      params.queueRow.source_run_id,
      params.review.provider,
      params.review.model,
      params.review.promptVersion,
      params.status,
      params.modelDecision,
      params.review.appliedDecision,
      params.review.confidence,
      params.review.reason,
      params.review.flags,
      params.review.suggestedCategory,
      params.review.normalizedTitle,
      params.review.rawResponse === null ? null : JSON.stringify(params.review.rawResponse),
      params.review.errorCode,
      params.review.errorMessage,
      JSON.stringify(params.inputSnapshot),
      params.review.processingMs,
    ])
  }

  async applyEventDecision(params: ApplyEventDecisionInput): Promise<boolean> {
    const { event, queueRow, review } = params
    const rows = await this.db.query<{ applied: boolean }>(APPLY_EVENT_DECISION_SQL, [
      queueRow.id,
      event.id,
      queueRow.source_id,
      queueRow.source_run_id,
      review.provider,
      review.model,
      review.promptVersion,
      review.status,
      review.modelDecision,
      review.appliedDecision,
      review.confidence,
      review.reason,
      review.flags,
      review.suggestedCategory,
      review.normalizedTitle,
      review.rawResponse === null ? null : JSON.stringify(review.rawResponse),
      review.errorCode,
      review.errorMessage,
      JSON.stringify(traceInputSnapshot(event)),
      review.processingMs,
    ])
    return rows[0]?.applied === true
  }

  async shouldAutoRejectSource(sourceId: string): Promise<boolean> {
    const rows = await this.db.query<{ should_reject: boolean }>(SHOULD_AUTO_REJECT_SOURCE_SQL, [
      sourceId,
    ])
    return rows[0]?.should_reject === true
  }

  async fetchEventEmbedding(eventId: string): Promise<string | null> {
    const rows = await this.db.query<{ embedding: string }>(FETCH_EVENT_EMBEDDING_SQL, [eventId])
    return rows[0]?.embedding ?? null
  }

  async fetchEventCityId(eventId: string): Promise<string | null> {
    const rows = await this.db.query<{ city_id: string | null }>(FETCH_EVENT_CITY_ID_SQL, [eventId])
    return rows[0]?.city_id ?? null
  }

  // ── MemoryContextDb ────────────────────────────────────────────────────────

  async getMemoryFeatureFlag(feature: MemoryFeature): Promise<{ enabled: boolean } | null> {
    return this.memory.getMemoryFeatureFlag(feature)
  }

  async findSimilarEvents(args: FindSimilarEventsArgs): Promise<SimilarEventRow[]> {
    return this.memory.findSimilarEvents(args)
  }

  async fetchEventTagsForEvents(eventIds: string[]): Promise<EventTagRow[]> {
    return this.memory.fetchEventTagsForEvents(eventIds)
  }

  async fetchTagDecisionsForEvents(eventIds: string[]): Promise<AdminDecisionRow[]> {
    return this.memory.fetchTagDecisionsForEvents(eventIds)
  }

  async fetchReviewEventsByIds(eventIds: string[]): Promise<ReviewEventRow[]> {
    return this.memory.fetchReviewEventsByIds(eventIds)
  }

  async fetchStatusDecisionsForEvents(eventIds: string[]): Promise<ReviewAdminDecisionRow[]> {
    return this.memory.fetchStatusDecisionsForEvents(eventIds)
  }
}
