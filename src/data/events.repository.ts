import { Injectable } from "@nestjs/common"
import { z } from "zod"

import { DbService } from "../db/db.service.js"
import { familyNeedsPredicateSql } from "../evidence/family-needs.js"
import type {
  DiscoverEventsInput,
  EnrichedEvent,
  ListEventsInput,
  ListMapEventsInput,
  MapEventsResult,
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

function familyNeedsProjectionSql(eventAlias: string): string {
  return `jsonb_build_object(
    'indoor', COALESCE((SELECT state FROM public.event_family_needs WHERE event_id = ${eventAlias}.id AND claim = 'indoor'), 'unknown'),
    'outdoor', COALESCE((SELECT state FROM public.event_family_needs WHERE event_id = ${eventAlias}.id AND claim = 'outdoor'), 'unknown'),
    'wheelchair_accessible', COALESCE((SELECT state FROM public.event_family_needs WHERE event_id = ${eventAlias}.id AND claim = 'wheelchair_accessible'), 'unknown'),
    'sensory_friendly', COALESCE((SELECT state FROM public.event_family_needs WHERE event_id = ${eventAlias}.id AND claim = 'sensory_friendly'), 'unknown'),
    'stroller_friendly', COALESCE((SELECT state FROM public.event_family_needs WHERE event_id = ${eventAlias}.id AND claim = 'stroller_friendly'), 'unknown')
  ) AS family_needs`
}

// Consumer event reads (U23): a port of family-events-app src/server/events.ts.
// The repositories call the deployed RPCs with the same named parameters.
// New schema and RPC behavior is owned by the API migration ledger and its
// schema tests; the deprecated backend is only the frozen bootstrap snapshot.

function publicImageAttributionsSql(eventAlias: "enriched" | "ee"): string {
  return `(
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'provider', a.provider,
      'image_url', a.image_url,
      'matched_tag', a.matched_tag,
      'photo_id', CASE a.provider
        WHEN 'unsplash' THEN a.unsplash_photo_id
        WHEN 'pexels' THEN a.pexels_photo_id
        WHEN 'pixabay' THEN a.pixabay_photo_id
      END,
      'photographer_name', CASE a.provider
        WHEN 'unsplash' THEN a.unsplash_photographer_name
        WHEN 'pexels' THEN a.pexels_photographer_name
        WHEN 'pixabay' THEN a.pixabay_photographer_name
      END,
      'photographer_username', CASE a.provider
        WHEN 'unsplash' THEN a.unsplash_photographer_username
        WHEN 'pixabay' THEN a.pixabay_photographer_username
      END,
      'photographer_profile_url', CASE a.provider
        WHEN 'unsplash' THEN a.unsplash_photographer_profile_url
        WHEN 'pexels' THEN a.pexels_photographer_profile_url
      END,
      'photo_url', CASE a.provider
        WHEN 'unsplash' THEN a.unsplash_photo_url
        WHEN 'pexels' THEN a.pexels_photo_url
        WHEN 'pixabay' THEN a.pixabay_photo_url
      END
    ) ORDER BY a.created_at, a.id), '[]'::jsonb)
    FROM public.event_image_attributions a
    WHERE a.event_id = ${eventAlias}.id
  ) AS image_attributions`
}

const LIST_SQL = `
WITH candidate AS (
  SELECT
  id, title, description, start_datetime, end_datetime, timezone,
  venue_name, address, city_id, latitude, longitude, age_min, age_max,
  price, is_free, admission_cost_state, admission_amount, admission_cost_evidence,
  parking_details, reservation_details,
  source_url, source_name, source_details_fetched_at,
  images, ${publicImageAttributionsSql("enriched")}, parent_tips, parent_tips_generated_at, is_outdoor,
  status, recurrence_info,
  is_featured, view_count, created_at, updated_at, avg_rating, rating_count,
  tags, is_favorited, is_in_calendar, ${familyNeedsProjectionSql("enriched")}
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
) AS enriched
)
SELECT candidate.*, NULL::text AS age_match
FROM candidate
WHERE status = $2::text
ORDER BY start_datetime ASC, id ASC
`

function extraDiscoveryPredicate(
  start: number,
  end: number,
  tags: number,
  lat: number,
  lng: number,
  radius: number,
  overlap?: number
): string {
  return `
    AND ($${start}::date IS NULL OR ${
      overlap === undefined
        ? `d.event_day >= $${start}::date`
        : `CASE WHEN $${overlap}::boolean AND e.end_datetime > e.start_datetime
        THEN e.end_datetime > ($${start}::date::timestamp AT TIME ZONE z.zone)
        ELSE d.event_day >= $${start}::date END`
    })
    AND ($${end}::date IS NULL OR d.event_day <= $${end}::date)
    AND (cardinality($${tags}::text[]) = 0 OR (
      SELECT count(DISTINCT t.slug) FROM public.event_tags et JOIN public.tags t ON t.id = et.tag_id
      WHERE et.event_id = e.id AND t.slug = ANY($${tags}::text[])
    ) = cardinality($${tags}::text[]))
    AND ($${radius}::float8 IS NULL OR (
      e.latitude BETWEEN -90 AND 90 AND e.longitude BETWEEN -180 AND 180
      AND extensions.earth_distance(
        extensions.ll_to_earth($${lat}::float8, $${lng}::float8),
        extensions.ll_to_earth(e.latitude::float8, e.longitude::float8)
      ) <= $${radius}::float8 * 1000
    ))`
}

function discoveryOrder(alias: string, sort: number): string {
  return `
    CASE WHEN $${sort}::text = 'price-asc' THEN ${alias}.price END ASC NULLS LAST,
    CASE WHEN $${sort}::text = 'rating-desc' THEN ${alias}.sort_rating END DESC,
    CASE WHEN $${sort}::text = 'rating-desc' THEN ${alias}.sort_rating_count END DESC,
    CASE WHEN $${sort}::text = 'latest' THEN ${alias}.start_datetime END DESC,
    CASE WHEN $${sort}::text <> 'latest' THEN ${alias}.start_datetime END ASC,
    CASE WHEN $${sort}::text = 'latest' THEN ${alias}.id END DESC,
    CASE WHEN $${sort}::text <> 'latest' THEN ${alias}.id END ASC`
}
const discoveryRatings = `LEFT JOIN LATERAL (
  SELECT COALESCE(round(avg(score)::numeric, 1), 0)::numeric AS sort_rating, count(*)::int AS sort_rating_count
  FROM public.ratings WHERE event_id = e.id
) ratings ON true`

const DISCOVERY_SQL = `
WITH candidates AS (
  SELECT e.id, e.start_datetime, e.price, ratings.sort_rating, ratings.sort_rating_count, ${ageProjectionSql(6, 7)}, ${familyNeedsProjectionSql("e")}
  FROM public.events e
  LEFT JOIN public.cities c ON c.id = e.city_id
  ${discoveryRatings}
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
          $1::text = 'past' OR (e.end_datetime IS NOT NULL AND e.end_datetime > $2::timestamptz)
          OR (e.end_datetime IS NULL AND e.start_datetime >= $2::timestamptz)
        )
        AND (
          $1::text = 'upcoming'
          OR ($1::text = 'past' AND d.event_day < d.local_today)
          OR ($1::text = 'week' AND d.event_day >= d.local_today AND d.event_day < d.local_today + 7)
          OR ($1::text = 'month' AND d.event_day >= d.local_today AND d.event_day < (d.local_today + interval '1 month')::date)
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
    ${extraDiscoveryPredicate(18, 19, 20, 21, 22, 23, 29)}
    AND ($15::boolean IS NULL OR e.is_free = $15::boolean)
    AND (NOT $28::boolean OR (e.end_datetime IS NOT NULL AND e.end_datetime > $2::timestamptz) OR (e.end_datetime IS NULL AND e.start_datetime >= $2::timestamptz))
    AND ${agePredicateSql(6, 7, 8)}
    AND ${familyNeedsPredicateSql("e", { familyNeeds: 16, includeUnknown: 17 })}
    AND (
      $11::timestamptz IS NULL
      OR ($24::text = 'soonest' AND (e.start_datetime, e.id) > ($11::timestamptz, $12::uuid))
      OR ($24::text = 'latest' AND (e.start_datetime, e.id) < ($11::timestamptz, $12::uuid))
      OR ($24::text = 'price-asc' AND (COALESCE(e.price,'Infinity'::numeric),e.start_datetime,e.id) > (COALESCE($25::numeric,'Infinity'::numeric),$11::timestamptz,$12::uuid))
      OR ($24::text = 'rating-desc' AND (-ratings.sort_rating,-ratings.sort_rating_count,e.start_datetime,e.id) > (-$26::numeric,-$27::int,$11::timestamptz,$12::uuid))
    )
  ORDER BY ${discoveryOrder("e", 24).replaceAll("e.sort_rating", "ratings.sort_rating")}
  LIMIT LEAST(GREATEST($13::int, 1), 500)
)
SELECT
  ee.id, ee.title, ee.description, ee.start_datetime, ee.end_datetime, ee.timezone,
  ee.venue_name, ee.address, ee.city_id, ee.latitude, ee.longitude, ee.age_min, ee.age_max,
  ee.price, ee.is_free, ee.admission_cost_state, ee.admission_amount,
  ee.admission_cost_evidence, ee.parking_details, ee.reservation_details,
  ee.source_url, ee.source_name, ee.source_details_fetched_at,
  ee.images, ${publicImageAttributionsSql("ee")}, ee.parent_tips, ee.parent_tips_generated_at, ee.is_outdoor,
  ee.status,
  ee.recurrence_info, ee.is_featured, ee.view_count, ee.created_at, ee.updated_at,
  ee.avg_rating, ee.rating_count, ee.tags, ee.is_favorited, ee.is_in_calendar,
  candidate.age_match, candidate.family_needs
FROM candidates candidate
JOIN public.events_enriched(
  p_user_id => $14::uuid,
  p_event_ids => ARRAY(SELECT id FROM candidates)::uuid[]
) ee ON ee.id = candidate.id
ORDER BY ${discoveryOrder("candidate", 24)}
`

const MAP_SQL = `
WITH matching AS MATERIALIZED (
SELECT
  e.id, e.title, e.latitude, e.longitude, e.start_datetime, e.timezone,
  e.venue_name, e.is_free, e.admission_cost_state, e.admission_amount, e.price, ratings.sort_rating, ratings.sort_rating_count,
  ${ageProjectionSql(4, 5)}, ${familyNeedsProjectionSql("e")}
FROM public.events e
LEFT JOIN public.cities c ON c.id = e.city_id
${discoveryRatings}
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
  AND ($2::text IS NULL OR $2::text = 'past' OR (
    (e.end_datetime IS NOT NULL AND e.end_datetime > $3::timestamptz)
    OR (e.end_datetime IS NULL AND e.start_datetime >= $3::timestamptz)
  ))
  AND (
    $2::text IS NULL OR $2::text = 'upcoming'
    OR ($2::text = 'past' AND d.event_day < d.local_today)
    OR ($2::text = 'week' AND d.event_day >= d.local_today AND d.event_day < d.local_today + 7)
    OR ($2::text = 'month' AND d.event_day >= d.local_today AND d.event_day < (d.local_today + interval '1 month')::date)
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
  ${extraDiscoveryPredicate(10, 11, 12, 13, 14, 15)}
  AND ($16::text IS NULL OR e.search_vector @@ websearch_to_tsquery('english', $16::text))
  AND ($17::timestamptz IS NULL OR e.start_datetime >= $17::timestamptz)
  AND ($18::timestamptz IS NULL OR e.start_datetime <= $18::timestamptz)
  AND ${agePredicateSql(4, 5, 6)}
  AND ${familyNeedsPredicateSql("e", { familyNeeds: 8, includeUnknown: 9 })}
  AND (
    $7::text = 'any'
    OR e.admission_cost_state::text = $7::text
  )
),
coordinate_counts AS (
  SELECT count(*) FILTER (
    WHERE latitude IS NULL OR longitude IS NULL
       OR latitude NOT BETWEEN -90 AND 90
       OR longitude NOT BETWEEN -180 AND 180
  )::int AS omitted_without_coordinates
  FROM matching
),
limited AS (
  SELECT *
  FROM matching
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    AND latitude BETWEEN -90 AND 90
    AND longitude BETWEEN -180 AND 180
  ORDER BY ${discoveryOrder("matching", 19)}
  LIMIT 200
)
SELECT limited.*, coordinate_counts.omitted_without_coordinates
FROM coordinate_counts
LEFT JOIN limited ON true
ORDER BY ${discoveryOrder("limited", 19)}
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

const parentTipSchema = z.object({ category: z.string().min(1), text: z.string().min(1) })
const imageAttributionSchema = z.object({
  provider: z.string(),
  image_url: z.string(),
  matched_tag: z.string().nullable(),
  photo_id: z.string().nullable(),
  photographer_name: z.string().nullable(),
  photographer_username: z.string().nullable(),
  photographer_profile_url: z.string().nullable(),
  photo_url: z.string().nullable(),
})

function publicEventContent(event: EnrichedEvent): EnrichedEvent {
  const tips = Array.isArray(event.parent_tips)
    ? event.parent_tips.flatMap((value) => {
        const parsed = parentTipSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })
    : []
  const attributions = Array.isArray(event.image_attributions)
    ? event.image_attributions.flatMap((value) => {
        const parsed = imageAttributionSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })
    : []
  return {
    ...event,
    parent_tips: tips.length ? tips : null,
    image_attributions: attributions,
  }
}

@Injectable()
export class EventsRepository {
  constructor(private readonly db: DbService) {}

  async listEvents(input: ListEventsInput = {}): Promise<EnrichedEvent[]> {
    const rows = await this.db.query<EnrichedEvent>(LIST_SQL, [
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
    return rows.map(publicEventContent)
  }

  async discoverEvents(input: DiscoverEventsInput): Promise<EnrichedEvent[]> {
    const rows = await this.db.query<EnrichedEvent>(DISCOVERY_SQL, [
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
      input.familyNeeds ?? [],
      input.includeUnknownFamilyNeeds ?? false,
      input.dateStart ?? null,
      input.dateEnd ?? null,
      input.tagSlugs ?? [],
      input.lat ?? null,
      input.lng ?? null,
      input.radiusKm ?? null,
      input.sort ?? "soonest",
      input.after?.price ?? null,
      input.after?.rating ?? null,
      input.after?.ratingCount ?? null,
      input.hidePast ?? false,
      input.dateOverlap ?? false,
    ])
    return rows.map(publicEventContent)
  }

  async listMapEvents(input: ListMapEventsInput): Promise<MapEventsResult> {
    const rows = await this.db.query<MappableEvent & { omitted_without_coordinates: number }>(
      MAP_SQL,
      [
        input.cityId ?? null,
        input.range,
        input.now,
        input.ages,
        input.ageMode,
        input.includeUnknownAge,
        input.cost ?? "any",
        input.familyNeeds ?? [],
        input.includeUnknownFamilyNeeds ?? false,
        input.dateStart ?? null,
        input.dateEnd ?? null,
        input.tagSlugs ?? [],
        input.lat ?? null,
        input.lng ?? null,
        input.radiusKm ?? null,
        input.keyword ?? null,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        input.sort ?? "soonest",
      ]
    )
    return {
      events: rows.filter((row) => row.id !== null),
      omittedWithoutCoordinates: rows[0]?.omitted_without_coordinates ?? 0,
    }
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
