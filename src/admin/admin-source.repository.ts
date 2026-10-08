import { Injectable, NotFoundException } from "@nestjs/common"

import type { SourceRunsQuery, SourceQueuesQuery } from "./admin-source-diagnostics.input.js"
import type {
  AdminSourceRunDto,
  AdminSourceRunsPageDto,
  AdminSourceRunDetailDto,
  AdminActiveQueueDto,
  AdminQueueSummaryDto,
  AdminActiveQueuePageDto,
} from "./admin-source-diagnostics.dto.js"
import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type {
  AdminCreateSourceInput,
  AdminExtractionMode,
  AdminProcessingMode,
  AdminSourcePatch,
  AdminSourceStatus,
  AdminSourceType,
} from "./admin-source.input.js"

export interface AdminSourceRow {
  id: string
  name: string
  url: string
  source_type: AdminSourceType
  extraction_mode: AdminExtractionMode
  processing_mode: AdminProcessingMode
  city_id: string | null
  is_active: boolean
  auto_approve: boolean
  scrape_interval_hours: number
  last_scraped_at: string | null
  last_status: AdminSourceStatus | null
  error_count: number
  notes: string | null
  date_window_days: number | null
  consecutive_zero_result_scrapes: number
  stale_escalated_at: string | null
  created_at: string
  updated_at: string
}

export interface AdminSourceScrapeResult {
  queueId: string
  deduped: boolean
}

export class InactiveAdminSourceError extends Error {
  constructor() {
    super("admin source is inactive")
    this.name = "InactiveAdminSourceError"
  }
}

const SOURCE_COLUMNS = `
id, name, url, source_type, extraction_mode, processing_mode, city_id, is_active,
auto_approve, scrape_interval_hours, last_scraped_at, last_status, error_count,
notes, date_window_days, consecutive_zero_result_scrapes, stale_escalated_at,
created_at, updated_at
`

const LIST_SOURCES_SQL = `
SELECT ${SOURCE_COLUMNS}
FROM public.event_sources
ORDER BY created_at DESC, id
`

export function toDatabaseSourcePatch(patch: AdminSourcePatch): Record<string, unknown> {
  return {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.sourceType !== undefined ? { source_type: patch.sourceType } : {}),
    ...(patch.extractionMode !== undefined ? { extraction_mode: patch.extractionMode } : {}),
    ...(patch.cityId !== undefined ? { city_id: patch.cityId } : {}),
    ...(patch.isActive !== undefined ? { is_active: patch.isActive } : {}),
    ...(patch.scrapeIntervalHours !== undefined
      ? { scrape_interval_hours: patch.scrapeIntervalHours }
      : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.dateWindowDays !== undefined ? { date_window_days: patch.dateWindowDays } : {}),
  }
}

function createPayload(input: AdminCreateSourceInput): Record<string, unknown> {
  return {
    name: input.name,
    url: input.url,
    source_type: input.sourceType,
    extraction_mode: input.extractionMode,
    city_id: input.cityId,
    is_active: input.isActive,
    // The dedicated mode RPC owns both processing_mode and auto_approve.
    auto_approve: false,
    scrape_interval_hours: input.scrapeIntervalHours,
    notes: input.notes,
    date_window_days: input.dateWindowDays,
  }
}

@Injectable()
export class AdminSourceRepository {
  constructor(private readonly db: DbService) {}

  runs(actor: string, query: SourceRunsQuery): Promise<AdminSourceRunsPageDto> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const params = [query.source_id ?? null, query.status ?? null]
      const filter = "($1::uuid IS NULL OR r.source_id=$1) AND ($2::text IS NULL OR r.status=$2)"
      const total = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM public.source_runs r WHERE ${filter}`,
        params
      )
      const rows = await client.query<AdminSourceRunDto>(
        `SELECT r.id,r.source_id,s.name AS source_name,r.started_at::text,r.completed_at::text,r.status,r.events_found,r.events_imported,r.events_skipped,r.error_log,r.created_at::text FROM public.source_runs r LEFT JOIN public.event_sources s ON s.id=r.source_id WHERE ${filter} AND ($3::timestamptz IS NULL OR (r.started_at,r.id)<($3::timestamptz,$4::uuid)) ORDER BY r.started_at DESC,r.id DESC LIMIT $5`,
        [...params, query.after_started_at ?? null, query.after_id ?? null, query.limit + 1]
      )
      const hasMore = rows.rows.length > query.limit
      const runs = rows.rows.slice(0, query.limit)
      const last = runs.at(-1)
      return {
        runs,
        total_count: total.rows[0]!.count,
        next_cursor:
          hasMore && last ? { after_started_at: last.started_at, after_id: last.id } : null,
      }
    })
  }
  runDetail(actor: string, id: string): Promise<AdminSourceRunDetailDto> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<AdminSourceRunDto>(
        "SELECT r.id,r.source_id,s.name AS source_name,r.started_at::text,r.completed_at::text,r.status,r.events_found,r.events_imported,r.events_skipped,r.error_log,r.created_at::text FROM public.source_runs r LEFT JOIN public.event_sources s ON s.id=r.source_id WHERE r.id=$1::uuid",
        [id]
      )
      const run = result.rows[0]
      if (!run) throw new NotFoundException()
      const traces = await client.query<AdminSourceRunDetailDto["traces"][number]>(
        "SELECT id::text,source_queue_id::text,extraction_mode::text,extractor,provider,model,status,input_bytes,parsed_event_count,fallback_reason,latency_ms,reasoning_summary,error,created_at::text FROM public.source_extraction_traces WHERE source_run_id=$1::uuid ORDER BY created_at DESC,id DESC LIMIT 200",
        [id]
      )
      return { run, traces: traces.rows }
    })
  }
  queues(actor: string, query: SourceQueuesQuery): Promise<AdminActiveQueuePageDto> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const source = query.kind === "source"
      const table = source ? "source_scrape_queue" : "event_tag_queue"
      const join = source
        ? "LEFT JOIN public.event_sources s ON s.id=q.source_id"
        : "JOIN public.events e ON e.id=q.event_id"
      const sourceId = source ? "q.source_id" : "e.source_id"
      const entity = source
        ? "q.source_id AS entity_id,s.name AS entity_name"
        : "q.event_id AS entity_id,e.title AS entity_name"
      const scope = `($1::uuid IS NULL OR ${sourceId}=$1)`
      const active = source
        ? "q.status::text IN ('pending','processing','retrying')"
        : "q.status::text IN ('pending','processing')"
      const params = [query.source_id ?? null]
      const summary = await client.query<AdminQueueSummaryDto>(
        `SELECT q.status::text,count(*)::int AS row_count,min(q.enqueued_at)::text AS oldest_enqueued_at,max(q.enqueued_at)::text AS newest_enqueued_at,min(q.started_at) FILTER(WHERE q.status::text='processing')::text AS oldest_processing_started_at,max(q.finished_at)::text AS newest_finished_at,max(q.finished_at) FILTER(WHERE q.status::text='dead')::text AS last_dead_letter_at,avg(q.attempt_count)::text AS avg_attempts FROM public.${table} q ${join} WHERE ${scope} GROUP BY q.status ORDER BY q.status`,
        params
      )
      const total = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM public.${table} q ${join} WHERE ${scope} AND ${active}`,
        params
      )
      const result = await client.query<AdminActiveQueueDto>(
        `SELECT q.id::text,${entity},${sourceId} AS source_id,q.source_run_id,q.status::text,q.trigger_type,q.attempt_count,q.enqueued_at::text,q.next_attempt_at::text,q.started_at::text,q.last_error FROM public.${table} q ${join} WHERE ${scope} AND ${active} AND ($2::bigint IS NULL OR q.id>$2::bigint) ORDER BY q.id LIMIT $3`,
        [...params, query.after_id ?? null, query.limit + 1]
      )
      const rows = result.rows.slice(0, query.limit)
      return {
        rows,
        summary: summary.rows,
        total_count: total.rows[0]!.count,
        next_cursor: result.rows.length > query.limit ? rows.at(-1)!.id : null,
      }
    })
  }

  choices(actor: string): Promise<{ cities: Array<{ id: string; name: string }> }> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const cities = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM public.cities ORDER BY name, id"
      )
      return { cities: cities.rows }
    })
  }

  list(actor: string): Promise<AdminSourceRow[]> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<AdminSourceRow>(LIST_SOURCES_SQL)
      return result.rows
    })
  }

  create(actor: string, input: AdminCreateSourceInput): Promise<AdminSourceRow> {
    return withAdminActor(this.db, actor, async (client) => {
      const created = await client.query<AdminSourceRow>(
        `SELECT ${SOURCE_COLUMNS}
         FROM public.admin_create_source($1::jsonb)`,
        [JSON.stringify(createPayload(input))]
      )
      const sourceId = created.rows[0]!.id
      const updated = await client.query<AdminSourceRow>(
        `SELECT ${SOURCE_COLUMNS}
         FROM public.admin_set_event_source_processing_mode(
           $1::uuid, $2::public.event_processing_mode
         )`,
        [sourceId, input.processingMode]
      )
      return updated.rows[0]!
    })
  }

  update(actor: string, sourceId: string, patch: AdminSourcePatch): Promise<AdminSourceRow> {
    return withAdminActor(this.db, actor, async (client) => {
      const result = await client.query<AdminSourceRow>(
        `SELECT ${SOURCE_COLUMNS}
         FROM public.admin_update_source($1::uuid, $2::jsonb)`,
        [sourceId, JSON.stringify(toDatabaseSourcePatch(patch))]
      )
      return result.rows[0]!
    })
  }

  setProcessingMode(
    actor: string,
    sourceId: string,
    mode: AdminProcessingMode
  ): Promise<AdminSourceRow> {
    return withAdminActor(this.db, actor, async (client) => {
      const result = await client.query<AdminSourceRow>(
        `SELECT ${SOURCE_COLUMNS}
         FROM public.admin_set_event_source_processing_mode(
           $1::uuid, $2::public.event_processing_mode
         )`,
        [sourceId, mode]
      )
      return result.rows[0]!
    })
  }

  bulkSetProcessingMode(actor: string, mode: AdminProcessingMode): Promise<void> {
    return withAdminActor(this.db, actor, async (client) => {
      await client.query(
        "SELECT public.admin_bulk_set_processing_mode($1::public.event_processing_mode)",
        [mode]
      )
    })
  }

  scrape(actor: string, sourceId: string): Promise<AdminSourceScrapeResult | null> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const source = await client.query<{ is_active: boolean }>(
        "SELECT is_active FROM public.event_sources WHERE id = $1::uuid FOR UPDATE",
        [sourceId]
      )
      if (source.rows[0] === undefined) return null
      if (!source.rows[0].is_active) throw new InactiveAdminSourceError()
      const result = await client.query<{ queue_id: string | null; deduped: boolean }>(
        `SELECT queue_id::text, deduped
         FROM public.enqueue_source_scrape($1::uuid, 'manual'::text)`,
        [sourceId]
      )
      const queueId = result.rows[0]?.queue_id
      if (queueId == null) throw new Error("source scrape enqueue returned no queue id")
      await client.query(
        "UPDATE public.event_sources SET last_status = 'pending' WHERE id = $1::uuid",
        [sourceId]
      )
      return { queueId, deduped: result.rows[0]!.deduped }
    })
  }
}
