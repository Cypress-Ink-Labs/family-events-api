import { Injectable } from "@nestjs/common"
import type { PoolClient } from "pg"

import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type {
  AdminEventPatch,
  AdminUpdateEventInput,
  JsonValue,
} from "./admin-event-editor.input.js"
import type { AdminStatus } from "./admin-review.input.js"

export interface AdminEditableEventRow {
  id: string
  title: string
  description: string | null
  start_datetime: string
  end_datetime: string | null
  timezone: string
  venue_name: string | null
  address: string | null
  city_id: string | null
  latitude: string | null
  longitude: string | null
  age_min: number | null
  age_max: number | null
  price: string | null
  is_free: boolean
  admission_cost_state: "free" | "paid" | "unknown"
  admission_amount: string | null
  admission_cost_evidence: string | null
  is_outdoor: boolean | null
  source_url: string | null
  source_name: string | null
  source_id: string | null
  images: string[]
  status: AdminStatus
  recurrence_info: JsonValue
  is_featured: boolean
  admin_locked_fields: string[]
  admin_last_edited_at: string | null
  admin_last_edited_by: string | null
  created_at: string
  updated_at: string
}

export interface AdminEditorTagRow {
  id: string
  name: string
  slug: string
  color: string
}

export interface AdminEventTagRow extends AdminEditorTagRow {
  confidence: string
  is_manual_override: boolean
}

export interface AdminEventEditorDetail {
  event: AdminEditableEventRow
  tags: AdminEventTagRow[]
  availableTags: AdminEditorTagRow[]
}

const EVENT_SQL = `
SELECT id, title, description, start_datetime, end_datetime, timezone, venue_name,
       address, city_id, latitude, longitude, age_min, age_max, price, is_free,
       admission_cost_state, admission_amount, admission_cost_evidence,
       is_outdoor, source_url, source_name, source_id, images, status,
       recurrence_info, is_featured, admin_locked_fields, admin_last_edited_at,
       admin_last_edited_by, created_at, updated_at
FROM public.events
WHERE id = $1::uuid
`

const EVENT_TAGS_SQL = `
SELECT t.id, t.name, t.slug, t.color, et.confidence, et.is_manual_override
FROM public.event_tags et
JOIN public.tags t ON t.id = et.tag_id
WHERE et.event_id = $1::uuid
ORDER BY t.name, t.id
`

const AVAILABLE_TAGS_SQL = `
SELECT id, name, slug, color
FROM public.tags
ORDER BY name, id
`

export function toDatabaseEventPatch(patch: AdminEventPatch): Record<string, unknown> {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.startDatetime !== undefined ? { start_datetime: patch.startDatetime } : {}),
    ...(patch.endDatetime !== undefined ? { end_datetime: patch.endDatetime } : {}),
    ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
    ...(patch.venueName !== undefined ? { venue_name: patch.venueName } : {}),
    ...(patch.address !== undefined ? { address: patch.address } : {}),
    ...(patch.cityId !== undefined ? { city_id: patch.cityId } : {}),
    ...(patch.latitude !== undefined ? { latitude: patch.latitude } : {}),
    ...(patch.longitude !== undefined ? { longitude: patch.longitude } : {}),
    ...(patch.ageMin !== undefined ? { age_min: patch.ageMin } : {}),
    ...(patch.ageMax !== undefined ? { age_max: patch.ageMax } : {}),
    ...(patch.price !== undefined ? { price: patch.price } : {}),
    ...(patch.isFree !== undefined ? { is_free: patch.isFree } : {}),
    ...(patch.admissionCostState !== undefined
      ? { admission_cost_state: patch.admissionCostState }
      : {}),
    ...(patch.admissionAmount !== undefined ? { admission_amount: patch.admissionAmount } : {}),
    ...(patch.admissionCostEvidence !== undefined
      ? { admission_cost_evidence: patch.admissionCostEvidence }
      : {}),
    ...(patch.isOutdoor !== undefined ? { is_outdoor: patch.isOutdoor } : {}),
    ...(patch.sourceUrl !== undefined ? { source_url: patch.sourceUrl } : {}),
    ...(patch.sourceName !== undefined ? { source_name: patch.sourceName } : {}),
    ...(patch.sourceId !== undefined ? { source_id: patch.sourceId } : {}),
    ...(patch.images !== undefined ? { images: patch.images } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.recurrenceInfo !== undefined ? { recurrence_info: patch.recurrenceInfo } : {}),
    ...(patch.isFeatured !== undefined ? { is_featured: patch.isFeatured } : {}),
  }
}

@Injectable()
export class AdminEventEditorRepository {
  constructor(private readonly db: DbService) {}

  private async detail(
    client: PoolClient,
    eventId: string
  ): Promise<AdminEventEditorDetail | null> {
    const eventResult = await client.query<AdminEditableEventRow>(EVENT_SQL, [eventId])
    const event = eventResult.rows[0]
    if (event === undefined) return null
    const [tags, availableTags] = await Promise.all([
      client.query<AdminEventTagRow>(EVENT_TAGS_SQL, [eventId]),
      client.query<AdminEditorTagRow>(AVAILABLE_TAGS_SQL),
    ])
    return { event, tags: tags.rows, availableTags: availableTags.rows }
  }

  get(actor: string, eventId: string): Promise<AdminEventEditorDetail | null> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      return this.detail(client, eventId)
    })
  }

  update(
    actor: string,
    eventId: string,
    input: AdminUpdateEventInput
  ): Promise<AdminEventEditorDetail> {
    return withAdminActor(this.db, actor, async (client) => {
      await client.query(
        `SELECT public.admin_update_event(
          $1::uuid, $2::jsonb, $3::uuid[], $4::boolean, $5::text
        )`,
        [
          eventId,
          JSON.stringify(toDatabaseEventPatch(input.patch)),
          input.tagIds,
          input.lockEditedFields,
          input.decisionReason,
        ]
      )
      const detail = await this.detail(client, eventId)
      if (detail === null) throw new Error("updated admin event disappeared")
      return detail
    })
  }

  unlock(actor: string, eventId: string): Promise<number> {
    return withAdminActor(this.db, actor, async (client) => {
      await client.query("SELECT public.admin_unlock_event_fields($1::uuid)", [eventId])
      return 1
    })
  }
}
