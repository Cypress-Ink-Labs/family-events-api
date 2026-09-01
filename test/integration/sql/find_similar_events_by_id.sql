-- find_similar_events_by_id RPCs, extracted VERBATIM from the latest legacy
-- definition in family-events-backend migration
-- 20260618000000_find_similar_events_by_id_security_definer.sql.
-- GRANT/REVOKE/COMMENT statements are omitted because the disposable database
-- does not install anon/authenticated/service_role roles.

CREATE OR REPLACE FUNCTION private.find_similar_events_by_id(
  p_event_id uuid,
  p_limit    int DEFAULT 5,
  p_city_id  uuid DEFAULT NULL
)
RETURNS TABLE (
  event_id        uuid,
  title           text,
  status          public.event_status,
  cosine_distance float,
  source_id       uuid,
  city_id         uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_embedding extensions.vector(1536);
BEGIN
  -- Look up the embedding ONLY for a PUBLISHED source event; empty otherwise.
  SELECT ee.embedding INTO v_embedding
  FROM public.event_embeddings ee
  JOIN public.events e ON e.id = ee.event_id
  WHERE ee.event_id = p_event_id
    AND e.status = 'published'::public.event_status;

  IF v_embedding IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT fse.*
  FROM private.find_similar_events(
    p_embedding        := v_embedding,
    p_limit            := p_limit,
    p_threshold        := 0.3,
    p_exclude_event_id := p_event_id,
    p_city_id          := p_city_id
  ) fse
  WHERE fse.status = 'published'::public.event_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.find_similar_events_by_id(
  p_event_id uuid,
  p_limit    int DEFAULT 5,
  p_city_id  uuid DEFAULT NULL
)
RETURNS TABLE (
  event_id        uuid,
  title           text,
  status          public.event_status,
  cosine_distance float,
  source_id       uuid,
  city_id         uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT * FROM private.find_similar_events_by_id(p_event_id, p_limit, p_city_id);
$$;
