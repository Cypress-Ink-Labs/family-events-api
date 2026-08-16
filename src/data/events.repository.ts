import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import { encodeEventCursor } from "./cursor.js"
import {
  escapeIlike,
  projectEvent,
  type EventListQuery,
  type EventListResult,
  type EventRow,
  type EventTag,
  type PublicEvent,
  type TagRow,
} from "./public-event.js"

const LIST_SQL = `
SELECT
  e.id,
  e.title,
  e.description,
  e.start_datetime,
  e.end_datetime,
  e.timezone,
  e.venue_name,
  e.address,
  e.city_id,
  e.latitude,
  e.longitude,
  e.age_min,
  e.age_max,
  e.price,
  e.is_free,
  e.is_featured,
  e.is_outdoor,
  e.images,
  e.source_url
FROM public.events e
WHERE e.status = 'published'
  AND ($1::uuid IS NULL OR e.city_id = $1)
  AND ($2::timestamptz IS NULL OR e.start_datetime >= $2)
  AND ($3::timestamptz IS NULL OR e.start_datetime <= $3)
  AND ($4::boolean IS NULL OR e.is_free = $4)
  AND (
    $5::text IS NULL
    OR e.title ILIKE '%' || $5 || '%' ESCAPE '\\'
    OR e.description ILIKE '%' || $5 || '%' ESCAPE '\\'
  )
  AND (
    $6::text[] IS NULL
    OR (
      SELECT COUNT(DISTINCT t.slug)
      FROM public.event_tags et
      JOIN public.tags t ON t.id = et.tag_id
      WHERE et.event_id = e.id AND t.slug = ANY($6)
    ) = cardinality($6)
  )
  AND (
    $7::timestamptz IS NULL
    OR (e.start_datetime, e.id) > ($7, $8::uuid)
  )
ORDER BY e.start_datetime ASC, e.id ASC
LIMIT $9
`

const GET_SQL = `
SELECT
  e.id,
  e.title,
  e.description,
  e.start_datetime,
  e.end_datetime,
  e.timezone,
  e.venue_name,
  e.address,
  e.city_id,
  e.latitude,
  e.longitude,
  e.age_min,
  e.age_max,
  e.price,
  e.is_free,
  e.is_featured,
  e.is_outdoor,
  e.images,
  e.source_url
FROM public.events e
WHERE e.id = $1 AND e.status = 'published'
`

const TAGS_SQL = `
SELECT et.event_id, t.id, t.name, t.slug, t.color
FROM public.event_tags et
JOIN public.tags t ON t.id = et.tag_id
WHERE et.event_id = ANY($1::uuid[])
ORDER BY t.slug ASC
`

/**
 * U23: published-event reads against the visible public schema.
 * Mirrors search_events filters used by the legacy events-api façade
 * (city, date window, is_free, tag AND, keyword ILIKE fallback, keyset cursor)
 * without calling the RPC — the API owns the SQL after cutover.
 */
@Injectable()
export class EventsRepository {
  constructor(private readonly db: DbService) {}

  async listPublished(query: EventListQuery): Promise<EventListResult> {
    const keyword = query.keyword?.trim() ?? ""
    const escapedKeyword = keyword.length > 0 && keyword.length <= 100 ? escapeIlike(keyword) : null
    const tagSlugs =
      query.tagSlugs !== undefined && query.tagSlugs !== null && query.tagSlugs.length > 0
        ? query.tagSlugs
        : null
    const fetchLimit = query.limit + 1
    const rows = await this.db.query<EventRow>(LIST_SQL, [
      query.cityId ?? null,
      query.dateFrom ?? null,
      query.dateTo ?? null,
      query.isFree ?? null,
      escapedKeyword,
      tagSlugs,
      query.cursor?.afterStart ?? null,
      query.cursor?.afterId ?? null,
      fetchLimit,
    ])
    const page = rows.slice(0, query.limit)
    const items = await this.withTags(page)
    const last = page[page.length - 1]
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? encodeEventCursor(last.start_datetime, last.id)
        : null
    return { items, nextCursor }
  }

  async findPublishedById(id: string): Promise<PublicEvent | null> {
    const rows = await this.db.query<EventRow>(GET_SQL, [id])
    const row = rows[0]
    if (row === undefined) return null
    const [event] = await this.withTags([row])
    return event ?? null
  }

  private async withTags(rows: EventRow[]): Promise<PublicEvent[]> {
    if (rows.length === 0) return []
    const tagRows = await this.db.query<TagRow>(TAGS_SQL, [rows.map((row) => row.id)])
    const tagsByEvent = new Map<string, EventTag[]>()
    for (const tag of tagRows) {
      const list = tagsByEvent.get(tag.event_id) ?? []
      list.push({ id: tag.id, name: tag.name, slug: tag.slug, color: tag.color })
      tagsByEvent.set(tag.event_id, list)
    }
    return rows.map((row) => projectEvent(row, tagsByEvent.get(row.id) ?? []))
  }
}
