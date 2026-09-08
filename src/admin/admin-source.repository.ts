import { Injectable } from "@nestjs/common"

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
