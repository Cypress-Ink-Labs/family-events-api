import { Injectable, NotFoundException } from "@nestjs/common"
import { DbService } from "../db/db.service.js"
import type { PublicEventDto, PublicEventsPageDto, SitemapEventDto } from "./public-exports.dto.js"
import type { parsePublicEventsQuery } from "./public-exports.query.js"

const PROJECTION = `e.id,e.title,e.description,e.start_datetime,e.end_datetime,e.timezone,
  e.venue_name,e.address,e.city_id,e.latitude::double precision,e.longitude::double precision,
  e.age_min,e.age_max,e.price::double precision,e.is_free,e.is_featured,e.is_outdoor,
  CASE WHEN jsonb_typeof(e.images) = 'array' THEN e.images ELSE '[]'::jsonb END AS images,e.source_url`

@Injectable()
export class PublicExportsRepository {
  constructor(private readonly db: DbService) {}

  async list(input: ReturnType<typeof parsePublicEventsQuery>): Promise<PublicEventsPageDto> {
    const rows = await this.db.query<PublicEventDto>(
      `
      SELECT ${PROJECTION}
      FROM public.search_events(
        p_city_id => $1::uuid, p_date_from => $2::timestamptz, p_date_to => $3::timestamptz,
        p_is_free => $4::boolean, p_tag_slugs => $5::text[], p_keyword => $6::text,
        p_limit => $7::int, p_after_start_datetime => $8::timestamptz, p_after_id => $9::uuid
      ) matched JOIN public.events e ON e.id = matched.id
      WHERE e.status = 'published'::public.event_status
      ORDER BY e.start_datetime ASC,e.id ASC`,
      [
        input.city_id ?? null,
        input.date_from ?? null,
        input.date_to ?? null,
        input.is_free === undefined ? null : input.is_free === "true",
        input.tags.length ? input.tags : null,
        input.keyword || null,
        input.limit + 1,
        input.cursor?.after_start ?? null,
        input.cursor?.after_id ?? null,
      ]
    )
    const more = rows.length > input.limit
    const data = rows.slice(0, input.limit)
    const last = data.at(-1)
    return {
      data,
      ...(more && last
        ? {
            next_cursor: Buffer.from(
              JSON.stringify({ after_start: last.start_datetime, after_id: last.id })
            ).toString("base64"),
          }
        : {}),
    }
  }
  async event(id: string): Promise<PublicEventDto> {
    const [event] = await this.db.query<PublicEventDto>(
      `SELECT ${PROJECTION} FROM public.events e WHERE e.id = $1::uuid AND e.status = 'published'::public.event_status`,
      [id]
    )
    if (!event) throw new NotFoundException("event not found")
    return event
  }
  feed(city: string | null): Promise<PublicEventDto[]> {
    return this.db.query<PublicEventDto>(
      `SELECT ${PROJECTION} FROM public.events e WHERE e.status = 'published'::public.event_status AND e.start_datetime >= now() AND ($1::uuid IS NULL OR e.city_id = $1::uuid) ORDER BY e.start_datetime ASC,e.id ASC LIMIT 200`,
      [city]
    )
  }
  sitemap(): Promise<SitemapEventDto[]> {
    return this.db.query<SitemapEventDto>(
      "SELECT id,start_datetime FROM public.events WHERE status = 'published'::public.event_status ORDER BY start_datetime DESC,id DESC LIMIT 5000"
    )
  }
}
