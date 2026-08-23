-- Enrichment RPCs, extracted VERBATIM from family-events-backend migrations
-- (U29). GRANT/REVOKE/COMMENT/RLS statements omitted: the bare test database
-- has no anon/authenticated/service_role roles and no RLS-aware clients.
--
-- Function sources (latest version wins; "latest" = last CREATE OR REPLACE
-- scanning migration files in filename order, top-to-bottom within a file):
--   list_events_needing_enrichment: 20260601006000_enrichment_images_and_rpc_cleanup.sql
--     (superseded 20260601002000 + 20260601004000 versions; this file itself
--     redefines it four times as the geocodable-address heuristic is
--     expanded across 009600/009700/009800/009901 — the 009901 version at
--     lines 1983-2111 is the last one in the file)
--   backfill_image_enrichment_in_scope: 20260601004000_llm_review_and_enrichment.sql
--     (this file redefines it twice; the second definition at lines
--     2290-2377 supersedes the first at lines 1940-2025)
--   update_event_enrichment: 20260601004000_llm_review_and_enrichment.sql
--     (superseded the 20260601002000 version)
--   mark_event_enrichment_attempt: 20260601004000_llm_review_and_enrichment.sql
--   upsert_event_image_attribution_with_enrichment: 20260601006000_enrichment_images_and_rpc_cleanup.sql
--   list_pending_unsplash_download_tracking: 20260601006000_enrichment_images_and_rpc_cleanup.sql
--   mark_unsplash_download_tracking_result: 20260601006000_enrichment_images_and_rpc_cleanup.sql
--   list_events_needing_attribution_backfill: 20260601006000_enrichment_images_and_rpc_cleanup.sql
--   list_events_needing_parent_tips: 20260601006000_enrichment_images_and_rpc_cleanup.sql
--   update_event_parent_tips: 20260601006000_enrichment_images_and_rpc_cleanup.sql

-- Source: 20260601006000_enrichment_images_and_rpc_cleanup.sql lines 1983-2111
CREATE OR REPLACE FUNCTION private.list_events_needing_enrichment(p_limit int DEFAULT 25)
RETURNS TABLE (
  event_id      uuid,
  title         text,
  description   text,
  venue_name    text,
  address       text,
  city_id       uuid,
  source_id     uuid,
  source_url    text,
  needs_coords  boolean,
  needs_images  boolean,
  admin_locked_fields text[],
  tags          text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH enrichment_flags AS (
    SELECT
      e.*,
      -- Geocode-eligible signals, in order of precision:
      --   (a) Street-number prefix ("433 Jefferson St")            — best
      --   (b) Street-type word in address ("101 W Vermilion St")   — good
      --   (c) Place-type word in address                           — fair
      --       (Park, Museum, Library, Center, Stadium, Gardens...
      --        + Building, Complex, Facility, Auditorium,
      --          Convention, Conference  [added 009901])
      --   (d) Same place-type set in venue_name                    — fair
      --   (e) Suite/unit indicators in address                     — good
      --       (Suite, Ste, Unit, Apt, Floor, Fl, Bldg, Building)
      --   (f) Extended venue place-types in address                — fair
      --       (Gym, Fitness, Studio, Kitchen, Cafe, Restaurant, ...)
      --   (g) Extended venue place-types in venue_name             — fair
      --   (h) venue_name starts with a street number               — good
      -- Anything else (raw room labels with no place noun) stays excluded.
      (
        e.address ~ '^\d+\s'
        OR e.address ~* '\m(St|Ave|Blvd|Rd|Dr|Hwy|Pkwy|Way|Ln|Lane|Court|Place|Highway|Parkway|Avenue|Street|Drive|Road|Circle|Cir)\M'
        OR e.address ~* '\m(Park|Museum|Library|Center|Centre|Stadium|Field|Gardens|Garden|Hall|Theater|Theatre|Church|School|University|College|Mall|Plaza|Market|Arena|Cathedral|Zoo|Aquarium|Observatory|Building|Complex|Facility|Auditorium|Convention|Conference)\M'
        OR e.venue_name ~* '\m(Park|Museum|Library|Center|Centre|Stadium|Field|Gardens|Garden|Hall|Theater|Theatre|Church|School|University|College|Mall|Plaza|Market|Arena|Cathedral|Zoo|Aquarium|Observatory|Building|Complex|Facility|Auditorium|Convention|Conference)\M'
        OR e.address ~* '\m(Suite|Ste|Unit|Apt|Floor|Fl|Bldg|Building)\M'
        OR e.address ~* '\m(Gym|Fitness|Studio|Kitchen|Cafe|Restaurant|Bar|Brewery|Winery|Club|Lodge|Pavilion|Amphitheater|Amphitheatre|Pool|Recreation|Rec)\M'
        OR e.venue_name ~* '\m(Gym|Fitness|Studio|Kitchen|Cafe|Restaurant|Bar|Brewery|Winery|Club|Lodge|Pavilion|Amphitheater|Amphitheatre|Pool|Recreation|Rec)\M'
        OR e.venue_name ~ '^\d+\s'
      ) AS _has_geocodable_address,
      (
        (
          e.latitude IS NULL
          OR e.longitude IS NULL
          OR (
            c.latitude IS NOT NULL
            AND c.longitude IS NOT NULL
            AND e.latitude IS NOT NULL
            AND e.longitude IS NOT NULL
            AND abs(e.latitude  - c.latitude)  < 0.000001
            AND abs(e.longitude - c.longitude) < 0.000001
          )
        )
        AND NOT 'latitude'  = ANY(e.admin_locked_fields)
        AND NOT 'longitude' = ANY(e.admin_locked_fields)
      ) AS _coords_unset_or_centroid,
      (
        (e.images = '[]'::jsonb OR jsonb_array_length(e.images) = 0)
        AND NOT 'images' = ANY(e.admin_locked_fields)
      ) AS _needs_images
    FROM public.events e
    LEFT JOIN public.cities c ON c.id = e.city_id
  ),
  event_tag_slugs AS (
    SELECT
      et.event_id,
      array_agg(t.slug ORDER BY et.confidence DESC NULLS LAST, t.slug ASC) AS slugs
    FROM public.event_tags et
    JOIN public.tags t ON t.id = et.tag_id
    GROUP BY et.event_id
  )
  SELECT
    ef.id,
    ef.title,
    ef.description,
    ef.venue_name,
    ef.address,
    ef.city_id,
    ef.source_id,
    ef.source_url,
    (ef._coords_unset_or_centroid AND ef._has_geocodable_address) AS needs_coords,
    ef._needs_images AS needs_images,
    ef.admin_locked_fields,
    COALESCE(ets.slugs, ARRAY[]::text[]) AS tags
  FROM enrichment_flags ef
  LEFT JOIN event_tag_slugs ets ON ets.event_id = ef.id
  WHERE
    (ef._coords_unset_or_centroid AND ef._has_geocodable_address)
    OR ef._needs_images
  ORDER BY ef.last_enrichment_attempt_at ASC NULLS FIRST, ef.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

CREATE OR REPLACE FUNCTION public.list_events_needing_enrichment(p_limit int DEFAULT 25)
RETURNS TABLE (
  event_id      uuid,
  title         text,
  description   text,
  venue_name    text,
  address       text,
  city_id       uuid,
  source_id     uuid,
  source_url    text,
  needs_coords  boolean,
  needs_images  boolean,
  admin_locked_fields text[],
  tags          text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT * FROM private.list_events_needing_enrichment(p_limit);
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 2290-2377
CREATE OR REPLACE FUNCTION private.backfill_image_enrichment_in_scope(p_limit int DEFAULT 25)
RETURNS TABLE (
  event_id      uuid,
  title         text,
  description   text,
  venue_name    text,
  address       text,
  city_id       uuid,
  source_id     uuid,
  source_url    text,
  needs_coords  boolean,
  needs_images  boolean,
  admin_locked_fields text[],
  tags          text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH scoped AS (
    SELECT e.*
    FROM public.events e
    WHERE e.status = 'published'
      AND (e.images = '[]'::jsonb OR jsonb_array_length(e.images) = 0)
      AND NOT 'images' = ANY(e.admin_locked_fields)
      AND (
        e.is_featured = true
        OR (e.start_datetime BETWEEN now() AND now() + interval '30 days')
      )
  ),
  event_tag_slugs AS (
    SELECT
      et.event_id,
      array_agg(t.slug ORDER BY et.confidence DESC NULLS LAST, t.slug ASC) AS slugs
    FROM public.event_tags et
    JOIN public.tags t ON t.id = et.tag_id
    GROUP BY et.event_id
  )
  SELECT
    s.id,
    s.title,
    s.description,
    s.venue_name,
    s.address,
    s.city_id,
    s.source_id,
    s.source_url,
    false                                                    AS needs_coords,
    true                                                     AS needs_images,
    s.admin_locked_fields,
    COALESCE(ets.slugs, ARRAY[]::text[])                     AS tags
  FROM scoped s
  LEFT JOIN event_tag_slugs ets ON ets.event_id = s.id
  ORDER BY s.last_enrichment_attempt_at ASC NULLS FIRST,
           s.is_featured DESC,
           s.start_datetime ASC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

CREATE OR REPLACE FUNCTION public.backfill_image_enrichment_in_scope(p_limit int DEFAULT 25)
RETURNS TABLE (
  event_id      uuid,
  title         text,
  description   text,
  venue_name    text,
  address       text,
  city_id       uuid,
  source_id     uuid,
  source_url    text,
  needs_coords  boolean,
  needs_images  boolean,
  admin_locked_fields text[],
  tags          text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT * FROM private.backfill_image_enrichment_in_scope(p_limit);
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 2381-2435
CREATE OR REPLACE FUNCTION private.update_event_enrichment(
  p_event_id   uuid,
  p_latitude   numeric,
  p_longitude  numeric,
  p_images     jsonb
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.events e SET
    latitude = CASE
      WHEN 'latitude' = ANY(e.admin_locked_fields) THEN e.latitude
      WHEN p_latitude IS NULL THEN e.latitude
      ELSE p_latitude
    END,
    longitude = CASE
      WHEN 'longitude' = ANY(e.admin_locked_fields) THEN e.longitude
      WHEN p_longitude IS NULL THEN e.longitude
      ELSE p_longitude
    END,
    images = CASE
      WHEN 'images' = ANY(e.admin_locked_fields) THEN e.images
      WHEN p_images IS NULL OR jsonb_array_length(p_images) = 0 THEN e.images
      ELSE p_images
    END,
    last_enrichment_attempt_at = now(),
    updated_at = now()
  WHERE e.id = p_event_id;
$$;

CREATE OR REPLACE FUNCTION public.update_event_enrichment(
  p_event_id   uuid,
  p_latitude   numeric,
  p_longitude  numeric,
  p_images     jsonb
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.update_event_enrichment(p_event_id, p_latitude, p_longitude, p_images);
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 2440-2463
CREATE OR REPLACE FUNCTION private.mark_event_enrichment_attempt(p_event_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.events
  SET last_enrichment_attempt_at = now()
  WHERE id = p_event_id;
$$;

CREATE OR REPLACE FUNCTION public.mark_event_enrichment_attempt(p_event_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.mark_event_enrichment_attempt(p_event_id);
$$;

-- Source: 20260601006000_enrichment_images_and_rpc_cleanup.sql lines 1036-1169
CREATE OR REPLACE FUNCTION private.upsert_event_image_attribution_with_enrichment(
  p_event_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_images jsonb,
  p_image_url text,
  p_unsplash_photo_id text,
  p_unsplash_photographer_name text,
  p_unsplash_photographer_username text,
  p_unsplash_photographer_profile_url text,
  p_unsplash_photo_url text,
  p_unsplash_download_location text,
  p_matched_tag text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attribution_id uuid;
  v_images_locked boolean;
  v_has_image boolean;
BEGIN
  SELECT 'images' = ANY(e.admin_locked_fields)
  INTO v_images_locked
  FROM public.events e
  WHERE e.id = p_event_id;

  IF v_images_locked IS NULL THEN
    RAISE EXCEPTION 'event % not found', p_event_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM private.update_event_enrichment(p_event_id, p_latitude, p_longitude, p_images);

  v_has_image := p_images IS NOT NULL
    AND jsonb_typeof(p_images) = 'array'
    AND p_image_url IS NOT NULL
    AND p_images ? p_image_url;

  IF v_images_locked OR NOT v_has_image THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.event_image_attributions (
    event_id,
    image_url,
    provider,
    matched_tag,
    unsplash_photo_id,
    unsplash_photographer_name,
    unsplash_photographer_username,
    unsplash_photographer_profile_url,
    unsplash_photo_url,
    unsplash_download_location,
    download_tracking_status,
    download_tracking_next_attempt_at
  ) VALUES (
    p_event_id,
    p_image_url,
    'unsplash',
    p_matched_tag,
    p_unsplash_photo_id,
    p_unsplash_photographer_name,
    p_unsplash_photographer_username,
    p_unsplash_photographer_profile_url,
    p_unsplash_photo_url,
    p_unsplash_download_location,
    'pending',
    now()
  )
  ON CONFLICT (event_id, image_url) DO UPDATE SET
    matched_tag = EXCLUDED.matched_tag,
    unsplash_photo_id = EXCLUDED.unsplash_photo_id,
    unsplash_photographer_name = EXCLUDED.unsplash_photographer_name,
    unsplash_photographer_username = EXCLUDED.unsplash_photographer_username,
    unsplash_photographer_profile_url = EXCLUDED.unsplash_photographer_profile_url,
    unsplash_photo_url = EXCLUDED.unsplash_photo_url,
    unsplash_download_location = EXCLUDED.unsplash_download_location,
    download_tracking_status = CASE
      WHEN public.event_image_attributions.download_tracked_at IS NULL THEN 'pending'
      ELSE public.event_image_attributions.download_tracking_status
    END,
    download_tracking_next_attempt_at = CASE
      WHEN public.event_image_attributions.download_tracked_at IS NULL THEN now()
      ELSE public.event_image_attributions.download_tracking_next_attempt_at
    END
  RETURNING id INTO v_attribution_id;

  RETURN v_attribution_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_event_image_attribution_with_enrichment(
  p_event_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_images jsonb,
  p_image_url text,
  p_unsplash_photo_id text,
  p_unsplash_photographer_name text,
  p_unsplash_photographer_username text,
  p_unsplash_photographer_profile_url text,
  p_unsplash_photo_url text,
  p_unsplash_download_location text,
  p_matched_tag text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.upsert_event_image_attribution_with_enrichment(
    p_event_id,
    p_latitude,
    p_longitude,
    p_images,
    p_image_url,
    p_unsplash_photo_id,
    p_unsplash_photographer_name,
    p_unsplash_photographer_username,
    p_unsplash_photographer_profile_url,
    p_unsplash_photo_url,
    p_unsplash_download_location,
    p_matched_tag
  );
$$;

-- Source: 20260601006000_enrichment_images_and_rpc_cleanup.sql lines 1178-1221
CREATE OR REPLACE FUNCTION private.list_pending_unsplash_download_tracking(p_limit int DEFAULT 25)
RETURNS TABLE (
  attribution_id uuid,
  event_id uuid,
  image_url text,
  download_location text,
  attempts integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    a.id AS attribution_id,
    a.event_id,
    a.image_url,
    a.unsplash_download_location AS download_location,
    a.download_tracking_attempts AS attempts
  FROM public.event_image_attributions a
  WHERE a.provider = 'unsplash'
    AND a.download_tracked_at IS NULL
    AND a.download_tracking_status IN ('pending', 'failed')
    AND a.download_tracking_next_attempt_at <= now()
  ORDER BY a.download_tracking_next_attempt_at ASC, a.created_at ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

CREATE OR REPLACE FUNCTION public.list_pending_unsplash_download_tracking(p_limit int DEFAULT 25)
RETURNS TABLE (
  attribution_id uuid,
  event_id uuid,
  image_url text,
  download_location text,
  attempts integer
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT * FROM private.list_pending_unsplash_download_tracking(p_limit);
$$;

-- Source: 20260601006000_enrichment_images_and_rpc_cleanup.sql lines 1226-1272
CREATE OR REPLACE FUNCTION private.mark_unsplash_download_tracking_result(
  p_attribution_id uuid,
  p_success boolean,
  p_error text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.event_image_attributions a
  SET
    download_tracking_attempts = a.download_tracking_attempts + 1,
    download_tracking_status = CASE WHEN p_success THEN 'succeeded' ELSE 'failed' END,
    download_tracked_at = CASE WHEN p_success THEN now() ELSE a.download_tracked_at END,
    download_tracking_last_error = CASE WHEN p_success THEN NULL ELSE NULLIF(left(COALESCE(p_error, 'unknown error'), 1000), '') END,
    download_tracking_next_attempt_at = CASE
      WHEN p_success THEN a.download_tracking_next_attempt_at
      ELSE now() + make_interval(mins => LEAST(1440, GREATEST(5, (a.download_tracking_attempts + 1) * 15)))
    END
  WHERE a.id = p_attribution_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attribution % not found', p_attribution_id USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_unsplash_download_tracking_result(
  p_attribution_id uuid,
  p_success boolean,
  p_error text DEFAULT NULL::text
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.mark_unsplash_download_tracking_result(p_attribution_id, p_success, p_error);
$$;

-- Source: 20260601006000_enrichment_images_and_rpc_cleanup.sql lines 1432-1478
CREATE OR REPLACE FUNCTION private.list_events_needing_attribution_backfill(p_limit int DEFAULT 10)
RETURNS TABLE (
  event_id uuid,
  image_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    e.id AS event_id,
    (e.images->>0) AS image_url
  FROM public.events e
  WHERE e.status = 'published'
    AND e.images IS NOT NULL
    AND jsonb_typeof(e.images) = 'array'
    AND jsonb_array_length(e.images) > 0
    AND (e.images->>0) ILIKE '%images.unsplash.com/%'
    AND NOT EXISTS (
      SELECT 1 FROM public.event_image_attributions a WHERE a.event_id = e.id
    )
  ORDER BY e.created_at ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

CREATE OR REPLACE FUNCTION public.list_events_needing_attribution_backfill(p_limit int DEFAULT 10)
RETURNS TABLE (
  event_id uuid,
  image_url text
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT * FROM private.list_events_needing_attribution_backfill(p_limit);
$$;

-- Source: 20260601006000_enrichment_images_and_rpc_cleanup.sql lines 550-626
CREATE OR REPLACE FUNCTION private.list_events_needing_parent_tips(
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  event_id        uuid,
  title           text,
  description     text,
  age_min         integer,
  age_max         integer,
  is_outdoor      boolean,
  venue_name      text,
  start_datetime  timestamptz,
  tags            text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH event_tag_slugs AS (
    SELECT
      et.event_id,
      array_agg(t.slug ORDER BY et.confidence DESC NULLS LAST, t.slug ASC) AS slugs
    FROM public.event_tags et
    JOIN public.tags t ON t.id = et.tag_id
    GROUP BY et.event_id
  )
  SELECT
    e.id,
    e.title,
    e.description,
    e.age_min,
    e.age_max,
    e.is_outdoor,
    e.venue_name,
    e.start_datetime,
    COALESCE(ets.slugs, ARRAY[]::text[]) AS tags
  FROM public.events e
  LEFT JOIN event_tag_slugs ets ON ets.event_id = e.id
  WHERE e.parent_tips IS NULL
    AND e.status = 'published'
    AND (e.llm_review_decision IS NULL OR e.llm_review_decision = 'approve')
  ORDER BY e.last_enrichment_attempt_at ASC NULLS FIRST, e.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 50));
$$;

CREATE OR REPLACE FUNCTION public.list_events_needing_parent_tips(
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  event_id        uuid,
  title           text,
  description     text,
  age_min         integer,
  age_max         integer,
  is_outdoor      boolean,
  venue_name      text,
  start_datetime  timestamptz,
  tags            text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT * FROM private.list_events_needing_parent_tips(p_limit);
$$;

-- Source: 20260601006000_enrichment_images_and_rpc_cleanup.sql lines 629-677
CREATE OR REPLACE FUNCTION private.update_event_parent_tips(
  p_event_id       uuid,
  p_tips           jsonb,
  p_provider       text,
  p_model          text,
  p_prompt_version text
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.events
  SET parent_tips                = p_tips,
      parent_tips_generated_at   = now(),
      parent_tips_provider       = p_provider,
      parent_tips_model          = p_model,
      parent_tips_prompt_version = p_prompt_version,
      last_enrichment_attempt_at = now(),
      updated_at                 = now()
  WHERE id = p_event_id;
$$;

CREATE OR REPLACE FUNCTION public.update_event_parent_tips(
  p_event_id       uuid,
  p_tips           jsonb,
  p_provider       text,
  p_model          text,
  p_prompt_version text
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.update_event_parent_tips(p_event_id, p_tips, p_provider, p_model, p_prompt_version);
$$;
