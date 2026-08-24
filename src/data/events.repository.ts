import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type {
  EnrichedEvent,
  ListEventsInput,
  SearchedEvent,
  SearchEventsInput,
  SimilarEvent,
  SimilarEventsInput,
} from "./types.js"

// Consumer event reads (U23): a port of family-events-app src/server/events.ts.
// The repositories call the same deployed RPCs with the same named parameters,
// so RPC semantics remain specified by the SQL integration tests in
// family-events-backend/supabase/tests/ (events_enriched_parity.sql etc.).
// The RPC SQL is inlined into the API only after cutover (plan U24 note).

const LIST_SQL = `
SELECT
  id, title, description, start_datetime, end_datetime, timezone,
  venue_name, address, city_id, latitude, longitude, age_min, age_max,
  price, is_free, source_url, source_name, images, status, recurrence_info,
  is_featured, view_count, created_at, updated_at, avg_rating, rating_count,
  tags, is_favorited, is_in_calendar
FROM public.events_enriched(
  p_city_id              => $1::uuid,
  p_status               => $2::text,
  p_user_id              => $3::uuid,
  p_event_ids            => $4::uuid[],
  p_date_from            => $5::timestamptz,
  p_date_to              => $6::timestamptz,
  p_after_start_datetime => $7::timestamptz,
  p_after_id             => $8::uuid,
  p_limit                => $9::int
)
WHERE status = $2::text
`

const SEARCH_SQL = `
SELECT
  id, title, description, start_datetime, end_datetime, venue_name, address,
  city_id, latitude, longitude, age_min, age_max, price, is_free, images,
  status, is_featured
FROM public.search_events(
  p_city_id              => $1::uuid,
  p_date_from            => $2::timestamptz,
  p_date_to              => $3::timestamptz,
  p_age_min              => $4::int,
  p_age_max              => $5::int,
  p_is_free              => $6::boolean,
  p_is_featured          => $7::boolean,
  p_tag_slugs            => $8::text[],
  p_keyword              => $9::text,
  p_limit                => $10::int,
  p_after_start_datetime => $11::timestamptz,
  p_after_id             => $12::uuid,
  p_lat                  => $13::double precision,
  p_lng                  => $14::double precision,
  p_radius_km            => $15::double precision
)
`

const SIMILAR_BY_ID_SQL = `
SELECT event_id::text, title
FROM public.find_similar_events_by_id(
  p_event_id => $1::uuid,
  p_limit    => $2::int,
  p_city_id  => $3::uuid
)
`

@Injectable()
export class EventsRepository {
  constructor(private readonly db: DbService) {}

  async listEvents(input: ListEventsInput = {}): Promise<EnrichedEvent[]> {
    return this.db.query<EnrichedEvent>(LIST_SQL, [
      input.cityId ?? null,
      input.status ?? "published",
      input.userKey ?? null,
      input.eventIds ?? null,
      input.dateFrom ?? null,
      input.dateTo ?? null,
      input.after?.startDatetime ?? null,
      input.after?.id ?? null,
      input.limit ?? 24,
    ])
  }

  async searchEvents(input: SearchEventsInput = {}): Promise<SearchedEvent[]> {
    return this.db.query<SearchedEvent>(SEARCH_SQL, [
      input.cityId ?? null,
      input.dateFrom ?? null,
      input.dateTo ?? null,
      input.ageMin ?? null,
      input.ageMax ?? null,
      input.isFree ?? null,
      input.isFeatured ?? null,
      input.tagSlugs ?? null,
      input.keyword ?? null,
      input.limit ?? 24,
      input.after?.startDatetime ?? null,
      input.after?.id ?? null,
      input.lat ?? null,
      input.lng ?? null,
      input.radiusKm ?? null,
    ])
  }

  async findSimilarEventsById(
    eventId: string,
    input: SimilarEventsInput = {}
  ): Promise<SimilarEvent[]> {
    return this.db.query<SimilarEvent>(SIMILAR_BY_ID_SQL, [
      eventId,
      input.limit ?? 5,
      input.cityId ?? null,
    ])
  }
}
