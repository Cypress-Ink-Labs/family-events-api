import { Injectable } from "@nestjs/common"

import { DbService } from "../../db/db.service.js"
import type {
  AdminAuditLogInsert,
  BulkImportResult,
  CrossSourceCandidateRow,
  EventSourceRunUpdate,
  ProcessSourceDb,
  SourceRunFinalization,
  SourceRunProgress,
} from "./process-source.js"
import type { ExtractionTraceInsert, SourceQueueDb, SourceQueueRow } from "./source-queue.worker.js"
import type { EventSourceRow } from "./types.js"

// SQL translations of the supabase-js queries and RPC calls the legacy
// scrape-source edge function issued (U28). The RPCs themselves
// (bulk_import_scrape_events, find_cross_source_event_candidates,
// invoke_process_tag_queue) stay in the database — the API calls the same
// public wrappers PostgREST exposed, so old and new pipelines share one
// implementation until U18 decommissions the edge functions.

const RESOLVE_CITY_TIMEZONE_SQL = `
SELECT timezone
FROM public.cities
WHERE id = $1::uuid
`

const FETCH_CITY_CENTROID_SQL = `
SELECT latitude::float8 AS latitude, longitude::float8 AS longitude
FROM public.cities
WHERE id = $1::uuid
`

const UPDATE_SOURCE_RUN_PROGRESS_SQL = `
UPDATE public.source_runs
SET events_found = $2, events_imported = $3, events_skipped = $4
WHERE id = $1::uuid
`

// start_datetime is re-serialized as UTC ISO 8601 because the dedup pre-pass
// compares eventFingerprint() strings sliced at minute precision against the
// parser payloads' ISO datetimes. PostgREST returned ISO to the edge function;
// pg's default text format ("2026-06-20 14:00:00+00") would silently break
// exact-fingerprint matching.
const FIND_CROSS_SOURCE_CANDIDATES_SQL = `
SELECT
  id::text,
  title,
  source_id::text,
  to_char(start_datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_datetime
FROM public.find_cross_source_event_candidates($1::uuid, $2::timestamptz, $3::timestamptz, $4::int)
`

const BULK_IMPORT_SCRAPE_EVENTS_SQL = `
SELECT public.bulk_import_scrape_events($1::uuid, $2::uuid, $3::jsonb) AS result
`

const FINALIZE_SOURCE_RUN_SQL = `
UPDATE public.source_runs
SET completed_at = $2::timestamptz,
    status = $3,
    events_found = $4,
    events_imported = $5,
    events_skipped = $6,
    error_log = $7
WHERE id = $1::uuid
`

// stale_escalated_at only appears in the update payload on a NEW escalation
// (idempotence: an already-escalated source keeps its original timestamp), so
// COALESCE keeps the existing value when the caller omitted it.
const UPDATE_EVENT_SOURCE_AFTER_RUN_SQL = `
UPDATE public.event_sources
SET last_scraped_at = $2::timestamptz,
    last_status = $3,
    error_count = $4,
    consecutive_zero_result_scrapes = $5,
    stale_escalated_at = COALESCE($6::timestamptz, stale_escalated_at)
WHERE id = $1::uuid
`

const INSERT_ADMIN_AUDIT_LOG_SQL = `
INSERT INTO public.admin_audit_log (action, target_type, target_id, admin_user_id, metadata)
VALUES ($1, $2, $3::uuid, $4::uuid, $5::jsonb)
`

const INVOKE_PROCESS_TAG_QUEUE_SQL = `
SELECT public.invoke_process_tag_queue()
`

// Queue RPCs (public wrappers over the private SECURITY DEFINER functions —
// the same surface PostgREST exposed to the edge functions). Queue ids are
// bigint; they are cast to int here because pg returns int8 as text and the
// worker compares ids numerically. The queue would need ~2^31 rows for that
// cast to matter.
const REAP_STUCK_SOURCE_SCRAPE_QUEUE_SQL = `
SELECT public.reap_stuck_source_scrape_queue_rows() AS reaped
`

const CLAIM_SOURCE_SCRAPE_QUEUE_SQL = `
SELECT id::int AS id, source_id::text, source_run_id::text, attempt_count
FROM public.claim_source_scrape_queue_batch($1::int)
`

const RELEASE_UNSTARTED_SOURCE_SCRAPE_QUEUE_SQL = `
SELECT public.release_unstarted_source_scrape_queue_rows($1::bigint[]) AS released
`

const MARK_SOURCE_SCRAPE_QUEUE_SKIPPED_SQL = `
SELECT public.mark_source_scrape_queue_skipped($1::bigint, $2)
`

const MARK_SOURCE_SCRAPE_QUEUE_STARTED_SQL = `
SELECT id::int AS id, source_id::text, source_run_id::text, attempt_count
FROM public.mark_source_scrape_queue_started($1::bigint)
`

const SCHEDULE_SOURCE_SCRAPE_RETRY_SQL = `
SELECT public.source_scrape_queue_schedule_retry($1::bigint, $2::int, $3)
`

const MARK_SOURCE_SCRAPE_QUEUE_SUCCEEDED_SQL = `
UPDATE public.source_scrape_queue
SET status = 'succeeded', finished_at = now(), last_error = NULL
WHERE id = $1::bigint
`

const GET_EVENT_SOURCE_SQL = `
SELECT id::text, name, url, source_type, extraction_mode, processing_mode,
       city_id::text, is_active, auto_approve, scrape_interval_hours,
       last_scraped_at, last_status, error_count, date_window_days,
       consecutive_zero_result_scrapes, stale_escalated_at
FROM public.event_sources
WHERE id = $1::uuid
`

const FETCH_CITY_TIMEZONE_SQL = `
SELECT timezone
FROM public.cities
WHERE id = $1::uuid
`

const CREATE_SOURCE_RUN_SQL = `
INSERT INTO public.source_runs (source_id, status)
VALUES ($1::uuid, 'running')
RETURNING id::text
`

const LINK_SOURCE_RUN_TO_QUEUE_ROW_SQL = `
UPDATE public.source_scrape_queue
SET source_run_id = $2::uuid
WHERE id = $1::bigint
`

const INSERT_EXTRACTION_TRACE_SQL = `
INSERT INTO public.source_extraction_traces
  (source_queue_id, source_run_id, source_id, extraction_mode, extractor, provider, model,
   status, input_bytes, parsed_event_count, fallback_reason, latency_ms, reasoning_summary, error)
VALUES
  ($1::bigint, $2::uuid, $3::uuid, $4::public.source_extraction_mode, $5, $6, $7,
   $8, $9, $10, $11, $12, $13, $14)
`

const MARK_SOURCE_RUN_ERROR_SQL = `
UPDATE public.source_runs
SET completed_at = now(), status = 'error', error_log = $2
WHERE id = $1::uuid
`

const RUN_DUE_SOURCE_SCRAPES_SQL = `
SELECT public.run_due_source_scrapes()
`

const RUN_CLEANUP_STALE_RUNS_SQL = `
SELECT public.run_cleanup_stale_runs()
`

const HAS_CLAIMABLE_SOURCE_SCRAPE_ROWS_SQL = `
SELECT EXISTS (
  SELECT 1 FROM public.source_scrape_queue
  WHERE status IN ('pending', 'retrying') AND next_attempt_at <= now()
) AS claimable
`

@Injectable()
export class IngestionRepository implements ProcessSourceDb, SourceQueueDb {
  constructor(private readonly db: DbService) {}

  async resolveCityTimezone(cityId: string | null): Promise<string> {
    if (!cityId) return "UTC"
    const rows = await this.db.query<{ timezone: string | null }>(RESOLVE_CITY_TIMEZONE_SQL, [
      cityId,
    ])
    const timezone = rows[0]?.timezone
    return typeof timezone === "string" && timezone ? timezone : "UTC"
  }

  async fetchCityCentroid(
    cityId: string | null
  ): Promise<{ latitude: number | null; longitude: number | null } | null> {
    if (!cityId) return null
    const rows = await this.db.query<{ latitude: number | null; longitude: number | null }>(
      FETCH_CITY_CENTROID_SQL,
      [cityId]
    )
    return rows[0] ?? null
  }

  async updateSourceRunProgress(runId: string, progress: SourceRunProgress): Promise<void> {
    await this.db.query(UPDATE_SOURCE_RUN_PROGRESS_SQL, [
      runId,
      progress.events_found,
      progress.events_imported,
      progress.events_skipped,
    ])
  }

  async findCrossSourceEventCandidates(args: {
    cityId: string
    startFrom: string
    startTo: string
    limit: number
  }): Promise<CrossSourceCandidateRow[]> {
    return this.db.query<CrossSourceCandidateRow>(FIND_CROSS_SOURCE_CANDIDATES_SQL, [
      args.cityId,
      args.startFrom,
      args.startTo,
      args.limit,
    ])
  }

  async bulkImportScrapeEvents(
    runId: string,
    sourceId: string,
    events: Record<string, unknown>[]
  ): Promise<BulkImportResult | null> {
    const rows = await this.db.query<{ result: BulkImportResult | null }>(
      BULK_IMPORT_SCRAPE_EVENTS_SQL,
      [runId, sourceId, JSON.stringify(events)]
    )
    return rows[0]?.result ?? null
  }

  async finalizeSourceRun(runId: string, finalization: SourceRunFinalization): Promise<void> {
    await this.db.query(FINALIZE_SOURCE_RUN_SQL, [
      runId,
      finalization.completed_at,
      finalization.status,
      finalization.events_found,
      finalization.events_imported,
      finalization.events_skipped,
      finalization.error_log,
    ])
  }

  async updateEventSourceAfterRun(sourceId: string, update: EventSourceRunUpdate): Promise<void> {
    await this.db.query(UPDATE_EVENT_SOURCE_AFTER_RUN_SQL, [
      sourceId,
      update.last_scraped_at,
      update.last_status,
      update.error_count,
      update.consecutive_zero_result_scrapes,
      update.stale_escalated_at ?? null,
    ])
  }

  async insertAdminAuditLog(row: AdminAuditLogInsert): Promise<void> {
    await this.db.query(INSERT_ADMIN_AUDIT_LOG_SQL, [
      row.action,
      row.target_type,
      row.target_id,
      row.admin_user_id,
      JSON.stringify(row.metadata),
    ])
  }

  async invokeProcessTagQueue(): Promise<void> {
    await this.db.query(INVOKE_PROCESS_TAG_QUEUE_SQL)
  }

  async reapStuckSourceScrapeQueueRows(): Promise<number> {
    const rows = await this.db.query<{ reaped: number }>(REAP_STUCK_SOURCE_SCRAPE_QUEUE_SQL)
    return Number(rows[0]?.reaped ?? 0)
  }

  async claimSourceScrapeQueueBatch(limit: number): Promise<SourceQueueRow[]> {
    return this.db.query<SourceQueueRow>(CLAIM_SOURCE_SCRAPE_QUEUE_SQL, [limit])
  }

  async releaseUnstartedSourceScrapeQueueRows(claimedIds: number[]): Promise<number> {
    const rows = await this.db.query<{ released: number }>(
      RELEASE_UNSTARTED_SOURCE_SCRAPE_QUEUE_SQL,
      [claimedIds]
    )
    return Number(rows[0]?.released ?? 0)
  }

  async markSourceScrapeQueueSkipped(queueId: number, reason: string): Promise<void> {
    await this.db.query(MARK_SOURCE_SCRAPE_QUEUE_SKIPPED_SQL, [queueId, reason])
  }

  async markSourceScrapeQueueStarted(queueId: number): Promise<SourceQueueRow> {
    const rows = await this.db.query<SourceQueueRow>(MARK_SOURCE_SCRAPE_QUEUE_STARTED_SQL, [
      queueId,
    ])
    // The claim transition guarantees the row is 'processing' with a NULL
    // started_at, so the guarded UPDATE always matches exactly one row.
    return rows[0] ?? { id: queueId, source_id: null, source_run_id: null, attempt_count: 0 }
  }

  async scheduleSourceScrapeRetry(
    queueId: number,
    attemptCount: number,
    error: string
  ): Promise<void> {
    await this.db.query(SCHEDULE_SOURCE_SCRAPE_RETRY_SQL, [queueId, attemptCount, error])
  }

  async markSourceScrapeQueueSucceeded(queueId: number): Promise<void> {
    await this.db.query(MARK_SOURCE_SCRAPE_QUEUE_SUCCEEDED_SQL, [queueId])
  }

  async getEventSource(sourceId: string): Promise<EventSourceRow | null> {
    const rows = await this.db.query<EventSourceRow>(GET_EVENT_SOURCE_SQL, [sourceId])
    return rows[0] ?? null
  }

  async fetchCityTimezone(cityId: string): Promise<string | null> {
    const rows = await this.db.query<{ timezone: string | null }>(FETCH_CITY_TIMEZONE_SQL, [cityId])
    return rows[0]?.timezone ?? null
  }

  async createSourceRun(sourceId: string): Promise<string> {
    const rows = await this.db.query<{ id: string }>(CREATE_SOURCE_RUN_SQL, [sourceId])
    const runId = rows[0]?.id
    if (!runId) throw new Error("source_runs insert returned no id")
    return runId
  }

  async linkSourceRunToQueueRow(queueId: number, runId: string): Promise<void> {
    await this.db.query(LINK_SOURCE_RUN_TO_QUEUE_ROW_SQL, [queueId, runId])
  }

  async insertExtractionTrace(row: ExtractionTraceInsert): Promise<void> {
    await this.db.query(INSERT_EXTRACTION_TRACE_SQL, [
      row.source_queue_id,
      row.source_run_id,
      row.source_id,
      row.extraction_mode,
      row.extractor,
      row.provider ?? null,
      row.model ?? null,
      row.status,
      row.input_bytes ?? null,
      row.parsed_event_count,
      row.fallback_reason ?? null,
      row.latency_ms ?? null,
      row.reasoning_summary ?? null,
      row.error ?? null,
    ])
  }

  async markSourceRunError(runId: string, errorMessage: string): Promise<void> {
    await this.db.query(MARK_SOURCE_RUN_ERROR_SQL, [runId, errorMessage])
  }

  async runDueSourceScrapes(): Promise<void> {
    await this.db.query(RUN_DUE_SOURCE_SCRAPES_SQL)
  }

  async runCleanupStaleRuns(): Promise<void> {
    await this.db.query(RUN_CLEANUP_STALE_RUNS_SQL)
  }

  async hasClaimableSourceScrapeRows(): Promise<boolean> {
    const rows = await this.db.query<{ claimable: boolean }>(HAS_CLAIMABLE_SOURCE_SCRAPE_ROWS_SQL)
    return rows[0]?.claimable ?? false
  }
}
