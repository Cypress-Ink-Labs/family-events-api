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

@Injectable()
export class IngestionRepository implements ProcessSourceDb {
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
}
