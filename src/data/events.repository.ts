import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type {
  DiscoverEventsInput,
  EnrichedEvent,
  ListEventsInput,
  ListMapEventsInput,
  MappableEvent,
  SearchedEvent,
  SearchEventsInput,
  SimilarEvent,
  SimilarEventsInput,
} from "./types.js"

function confirmedAgeSql(ages: number, mode: number): string {
  return `(
    age_min IS NOT NULL AND age_max IS NOT NULL
    AND CASE WHEN $${mode}::text = 'any'
      THEN EXISTS (
        SELECT 1 FROM unnest($${ages}::int[]) AS selected(age)
        WHERE selected.age BETWEEN age_min AND age_max
      )
      ELSE NOT EXISTS (
        SELECT 1 FROM unnest($${ages}::int[]) AS selected(age)
        WHERE selected.age NOT BETWEEN age_min AND age_max
      )
    END
  )`
}

function contradictedAgeSql(ages: number, mode: number): string {
  const mismatch = `(
    (age_min IS NOT NULL AND selected.age < age_min)
    OR (age_max IS NOT NULL AND selected.age > age_max)
  )`
  return `(CASE WHEN $${mode}::text = 'any'
    THEN NOT EXISTS (
      SELECT 1 FROM unnest($${ages}::int[]) AS selected(age)
      WHERE NOT ${mismatch}
    )
    ELSE EXISTS (
      SELECT 1 FROM unnest($${ages}::int[]) AS selected(age)
      WHERE ${mismatch}
    )
  END)`
}

function ageProjectionSql(ages: number, mode: number): string {
  return `CASE
    WHEN cardinality($${ages}::int[]) = 0 THEN NULL::text
    WHEN ${confirmedAgeSql(ages, mode)} THEN 'confirmed'::text
    ELSE 'unknown'::text
  END AS age_match`
}

function agePredicateSql(ages: number, mode: number, includeUnknown: number): string {
  return `(
    cardinality($${ages}::int[]) = 0
    OR CASE WHEN $${includeUnknown}::boolean
      THEN NOT ${contradictedAgeSql(ages, mode)}
      ELSE ${confirmedAgeSql(ages, mode)}
    END
  )`
}

// Consumer event reads (U23): a port of family-events-app src/server/events.ts.
// The repositories call the same deployed RPCs with the same named parameters,
// so RPC semantics remain specified by the SQL integration tests in
// family-events-backend/supabase/tests/ (events_enriched_parity.sql etc.).
// The RPC SQL is inlined into the API only after cutover (plan U24 note).

const LIST_SQL = `
WITH candidate AS (
  SELECT
  id, title, description, start_datetime, end_datetime, timezone,
  venue_name, address, city_id, latitude, longitude, age_min, age_max,
  price, is_free, admission_cost_state, admission_amount, admission_cost_evidence,
  source_url, source_name, source_details_fetched_at,
  images, status, recurrence_info,
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
)
SELECT candidate.*, NULL::text AS age_match
FROM candidate
WHERE status = $2::text
ORDER BY start_datetime ASC, id ASC
`

const DISCOVERY_SQL = `
WITH candidates AS (
  SELECT e.id, e.start_datetime, ${ageProjectionSql(6, 7)}
  FROM public.events e
  LEFT JOIN public.cities c ON c.id = e.city_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(NULLIF(e.timezone, ''), c.timezone, 'America/Chicago') AS zone
  ) z
  CROSS JOIN LATERAL (
    SELECT
      ($2::timestamptz AT TIME ZONE z.zone)::date AS local_today,
      (e.start_datetime AT TIME ZONE z.zone)::date AS event_day
  ) d
  WHERE e.status = 'published'::public.event_status
    AND ($3::uuid IS NULL OR e.city_id = $3::uuid)
    AND (
      (
        $1::text IS NULL
        AND ($9::timestamptz IS NULL OR e.start_datetime >= $9::timestamptz)
        AND ($10::timestamptz IS NULL OR e.start_datetime <= $10::timestamptz)
      )
      OR (
        $1::text IS NOT NULL
        AND (
          (e.end_datetime IS NOT NULL AND e.end_datetime > $2::timestamptz)
          OR (e.end_datetime IS NULL AND e.start_datetime >= $2::timestamptz)
        )
        AND (
          $1::text = 'upcoming'
          OR ($1::text = 'today' AND d.event_day = d.local_today)
          OR (
            $1::text = 'weekend'
            AND d.event_day BETWEEN
              d.local_today + CASE
                WHEN EXTRACT(ISODOW FROM d.local_today) = 7 THEN -2
                ELSE 5 - EXTRACT(ISODOW FROM d.local_today)::int
              END
              AND d.local_today + CASE
                WHEN EXTRACT(ISODOW FROM d.local_today) = 7 THEN 0
                ELSE 7 - EXTRACT(ISODOW FROM d.local_today)::int
              END
          )
        )
      )
    )
    AND (
      $4::text IS NULL
      OR e.search_vector @@ websearch_to_tsquery('english', $4::text)
    )
    AND (
      $5::text IS NULL OR $5::text = 'any'
      OR e.admission_cost_state::text = $5::text
    )
    AND ($15::boolean IS NULL OR e.is_free = $15::boolean)
    AND ${agePredicateSql(6, 7, 8)}
    AND (
      $11::timestamptz IS NULL
      OR (e.start_datetime, e.id) > ($11::timestamptz, $12::uuid)
    )
  ORDER BY e.start_datetime ASC, e.id ASC
  LIMIT LEAST(GREATEST($13::int, 1), 500)
)
SELECT
  ee.id, ee.title, ee.description, ee.start_datetime, ee.end_datetime, ee.timezone,
  ee.venue_name, ee.address, ee.city_id, ee.latitude, ee.longitude, ee.age_min, ee.age_max,
  ee.price, ee.is_free, ee.admission_cost_state, ee.admission_amount,
  ee.admission_cost_evidence, ee.source_url, ee.source_name, ee.source_details_fetched_at,
  ee.images, ee.status,
  ee.recurrence_info, ee.is_featured, ee.view_count, ee.created_at, ee.updated_at,
  ee.avg_rating, ee.rating_count, ee.tags, ee.is_favorited, ee.is_in_calendar,
  candidate.age_match
FROM candidates candidate
JOIN public.events_enriched(
  p_user_id => $14::uuid,
  p_event_ids => ARRAY(SELECT id FROM candidates)::uuid[]
) ee ON ee.id = candidate.id
ORDER BY candidate.start_datetime ASC, candidate.id ASC
`

const MAP_SQL = `
SELECT
  e.id, e.title, e.latitude, e.longitude, e.start_datetime, e.timezone,
  e.venue_name, e.is_free, e.admission_cost_state, e.admission_amount,
  ${ageProjectionSql(4, 5)}
FROM public.events e
LEFT JOIN public.cities c ON c.id = e.city_id
CROSS JOIN LATERAL (
  SELECT COALESCE(NULLIF(e.timezone, ''), c.timezone, 'America/Chicago') AS zone
) z
CROSS JOIN LATERAL (
  SELECT
    ($3::timestamptz AT TIME ZONE z.zone)::date AS local_today,
    (e.start_datetime AT TIME ZONE z.zone)::date AS event_day
) d
WHERE e.status = 'published'::public.event_status
  AND ($1::uuid IS NULL OR e.city_id = $1::uuid)
  AND (
    (e.end_datetime IS NOT NULL AND e.end_datetime > $3::timestamptz)
    OR (e.end_datetime IS NULL AND e.start_datetime >= $3::timestamptz)
  )
  AND (
    $2::text = 'upcoming'
    OR ($2::text = 'today' AND d.event_day = d.local_today)
    OR (
      $2::text = 'weekend'
      AND d.event_day BETWEEN
        d.local_today + CASE
          WHEN EXTRACT(ISODOW FROM d.local_today) = 7 THEN -2
          ELSE 5 - EXTRACT(ISODOW FROM d.local_today)::int
        END
        AND d.local_today + CASE
          WHEN EXTRACT(ISODOW FROM d.local_today) = 7 THEN 0
          ELSE 7 - EXTRACT(ISODOW FROM d.local_today)::int
        END
    )
  )
  AND ${agePredicateSql(4, 5, 6)}
  AND (
    $7::text = 'any'
    OR e.admission_cost_state::text = $7::text
  )
ORDER BY e.start_datetime ASC, e.id ASC
`

const SEARCH_SQL = `
WITH candidate AS (
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
)
SELECT candidate.*, NULL::text AS age_match
FROM candidate
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

  async discoverEvents(input: DiscoverEventsInput): Promise<EnrichedEvent[]> {
    return this.db.query<EnrichedEvent>(DISCOVERY_SQL, [
      input.range,
      input.now,
      input.cityId ?? null,
      input.keyword ?? null,
      input.cost ?? null,
      input.ages,
      input.ageMode,
      input.includeUnknownAge,
      input.dateFrom ?? null,
      input.dateTo ?? null,
      input.after?.startDatetime ?? null,
      input.after?.id ?? null,
      input.limit ?? 24,
      input.userKey ?? null,
      input.isFree ?? null,
    ])
  }

  async listMapEvents(input: ListMapEventsInput): Promise<MappableEvent[]> {
    return this.db.query<MappableEvent>(MAP_SQL, [
      input.cityId ?? null,
      input.range,
      input.now,
      input.ages,
      input.ageMode,
      input.includeUnknownAge,
      input.cost ?? "any",
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
