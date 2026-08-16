-- S05/T01: Add radius (lat/lng/km) parameters to search_events RPC
-- Uses earth_distance extension (already enabled) following plan_events_for_user pattern.
-- When p_lat, p_lng, and p_radius_km are all non-null, filters results to events
-- within the given radius using earth_distance. Existing behaviour unchanged when null.

CREATE OR REPLACE FUNCTION public.search_events(
  p_city_id uuid DEFAULT NULL::uuid,
  p_date_from timestamptz DEFAULT NULL::timestamptz,
  p_date_to timestamptz DEFAULT NULL::timestamptz,
  p_age_min integer DEFAULT NULL::integer,
  p_age_max integer DEFAULT NULL::integer,
  p_is_free boolean DEFAULT NULL::boolean,
  p_is_featured boolean DEFAULT NULL::boolean,
  p_tag_slugs text[] DEFAULT NULL::text[],
  p_keyword text DEFAULT NULL::text,
  p_status text DEFAULT 'published'::text,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0,
  p_after_start_datetime timestamptz DEFAULT NULL::timestamptz,
  p_after_id uuid DEFAULT NULL::uuid,
  -- New radius parameters
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_radius_km double precision DEFAULT NULL::double precision
)
RETURNS SETOF events
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  WITH search_input AS (
    SELECT
      CASE
        WHEN p_keyword IS NULL OR btrim(p_keyword) = '' OR length(p_keyword) > 100 THEN NULL::text
        ELSE btrim(p_keyword)
      END AS kw,
      CASE
        WHEN p_keyword IS NULL OR btrim(p_keyword) = '' OR length(p_keyword) > 100 THEN NULL::tsquery
        ELSE websearch_to_tsquery('english', btrim(p_keyword))
      END AS tsq,
      CASE
        WHEN p_keyword IS NULL OR btrim(p_keyword) = '' OR length(p_keyword) > 100 THEN NULL::text
        ELSE replace(replace(replace(btrim(p_keyword), '\', '\\'), '%', '\%'), '_', '\_')
      END AS escaped_kw,
      -- Radius filtering is active only when all three params are non-null
      (p_lat IS NOT NULL AND p_lng IS NOT NULL AND p_radius_km IS NOT NULL) AS radius_active
  )
  SELECT e.*
  FROM public.events e
  CROSS JOIN search_input si
  WHERE e.status::text = p_status
    AND (p_city_id IS NULL OR e.city_id = p_city_id)
    AND (p_date_from IS NULL OR e.start_datetime >= p_date_from)
    AND (p_date_to IS NULL OR e.start_datetime <= p_date_to)
    AND (p_is_free IS NULL OR e.is_free = p_is_free)
    AND (p_is_featured IS NULL OR e.is_featured = p_is_featured)
    AND (p_age_min IS NULL OR COALESCE(e.age_max, 99) >= p_age_min)
    AND (p_age_max IS NULL OR COALESCE(e.age_min, 0) <= p_age_max)
    -- Radius filter: events must have coordinates and be within p_radius_km
    AND (
      NOT si.radius_active
      OR (
        e.latitude IS NOT NULL
        AND e.longitude IS NOT NULL
        AND extensions.earth_distance(
          extensions.ll_to_earth(p_lat, p_lng),
          extensions.ll_to_earth(e.latitude::float8, e.longitude::float8)
        ) <= p_radius_km * 1000.0
      )
    )
    -- Keyword / FTS filter (unchanged)
    AND (
      si.kw IS NULL
      OR (
        si.tsq IS NOT NULL
        AND numnode(si.tsq) > 0
        AND e.search_vector @@ si.tsq
      )
      OR (
        si.escaped_kw IS NOT NULL
        AND (numnode(si.tsq) = 0 OR length(si.kw) < 3)
        AND (
          e.title ILIKE '%' || si.escaped_kw || '%' ESCAPE '\'
          OR e.description ILIKE '%' || si.escaped_kw || '%' ESCAPE '\'
        )
      )
    )
    -- Tag filter (unchanged)
    AND (
      p_tag_slugs IS NULL
      OR array_length(p_tag_slugs, 1) IS NULL
      OR (
        SELECT COUNT(DISTINCT t.slug)
        FROM public.event_tags et
        JOIN public.tags t ON t.id = et.tag_id
        WHERE et.event_id = e.id AND t.slug = ANY(p_tag_slugs)
      ) = array_length(p_tag_slugs, 1)
    )
    -- Cursor pagination (unchanged)
    AND (
      p_after_start_datetime IS NULL
      OR (e.start_datetime, e.id) > (p_after_start_datetime, p_after_id)
    )
  ORDER BY
    CASE
      WHEN si.tsq IS NULL OR numnode(si.tsq) = 0 THEN NULL::real
      ELSE ts_rank_cd(e.search_vector, si.tsq)
    END DESC NULLS LAST,
    e.start_datetime ASC,
    e.id ASC
  LIMIT LEAST(GREATEST(p_limit, 0), 500)
  OFFSET GREATEST(p_offset, 0);
$function$;
