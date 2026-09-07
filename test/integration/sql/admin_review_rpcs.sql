-- Verbatim legacy RPC definitions and September escape patches. Grants omitted.

-- Source: 20260610170000_admin_events_source_filter.sql
CREATE OR REPLACE FUNCTION private.admin_events_enriched(
  p_status               text                              DEFAULT NULL::text,
  p_city_id              uuid                              DEFAULT NULL::uuid,
  p_city_is_null         boolean                           DEFAULT NULL::boolean,
  p_keyword              text                              DEFAULT NULL::text,
  p_after_created_at     timestamptz                       DEFAULT NULL::timestamptz,
  p_after_id             uuid                              DEFAULT NULL::uuid,
  p_limit                int                               DEFAULT 50,
  p_llm_review_status    public.llm_event_review_status    DEFAULT NULL::public.llm_event_review_status,
  p_llm_review_decision  public.llm_event_review_decision  DEFAULT NULL::public.llm_event_review_decision,
  p_llm_reviewed         boolean                           DEFAULT NULL::boolean,
  p_source_id            uuid                              DEFAULT NULL::uuid
)
RETURNS TABLE (
  id                    uuid,
  title                 text,
  description           text,
  start_datetime        timestamptz,
  end_datetime          timestamptz,
  timezone              text,
  venue_name            text,
  address               text,
  city_id               uuid,
  latitude              numeric,
  longitude             numeric,
  age_min               int,
  age_max               int,
  price                 numeric,
  is_free               boolean,
  source_url            text,
  source_name           text,
  source_id             uuid,
  images                jsonb,
  status                text,
  ai_confidence         numeric,
  ai_tag_provider       text,
  recurrence_info       jsonb,
  is_featured           boolean,
  view_count            int,
  search_vector         tsvector,
  admin_locked_fields   text[],
  admin_last_edited_at  timestamptz,
  admin_last_edited_by  uuid,
  created_at            timestamptz,
  updated_at            timestamptz,
  ai_tag_model          text,
  ai_tag_status         text,
  llm_review_status     public.llm_event_review_status,
  llm_review_decision   public.llm_event_review_decision,
  llm_review_confidence numeric(4,3),
  llm_review_reason     text,
  llm_review_flags      text[],
  llm_review_provider   text,
  llm_review_model      text,
  llm_review_prompt_version text,
  llm_reviewed_at       timestamptz,
  llm_review_error      text,
  total_count           bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
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
        ELSE replace(replace(replace(btrim(p_keyword), '\\', '\\\\'), '%', '\\%'), '_', '\\_')
      END AS escaped_kw,
      LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) AS page_size
  ),
  base AS (
    SELECT e.*
    FROM public.events e
    CROSS JOIN search_input si
    WHERE
      (p_status IS NULL OR e.status::text = p_status)
      AND (
        p_city_is_null IS NULL
        OR (p_city_is_null = true  AND e.city_id IS NULL)
        OR (p_city_is_null = false AND e.city_id IS NOT NULL)
      )
      AND (p_city_id IS NULL OR e.city_id = p_city_id)
      AND (p_source_id IS NULL OR e.source_id = p_source_id)
      AND (p_llm_review_status IS NULL OR e.llm_review_status = p_llm_review_status)
      AND (p_llm_review_decision IS NULL OR e.llm_review_decision = p_llm_review_decision)
      AND (
        p_llm_reviewed IS DISTINCT FROM true
        OR (
          e.llm_reviewed_at IS NOT NULL
          AND e.llm_review_decision IS NOT NULL
          AND e.llm_review_status <> 'failed'::public.llm_event_review_status
        )
      )
      AND (
        si.kw IS NULL
        OR (
          si.tsq IS NOT NULL
          AND numnode(si.tsq) > 0
          AND e.search_vector @@ si.tsq
        )
        OR (
          si.escaped_kw IS NOT NULL
          AND (si.tsq IS NULL OR numnode(si.tsq) = 0 OR length(si.kw) < 3)
          AND (
            e.title ILIKE '%' || si.escaped_kw || '%' ESCAPE '\\'
            OR e.description ILIKE '%' || si.escaped_kw || '%' ESCAPE '\\'
          )
        )
      )
  ),
  base_count AS (
    SELECT COUNT(*)::bigint AS total_count FROM base
  ),
  page AS (
    SELECT b.*, c.total_count
    FROM base b
    CROSS JOIN base_count c
    WHERE (
      p_after_created_at IS NULL
      OR (
        p_after_id IS NULL
        AND b.created_at < p_after_created_at
      )
      OR (
        p_after_id IS NOT NULL
        AND (b.created_at, b.id) < (p_after_created_at, p_after_id)
      )
    )
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT (SELECT page_size FROM search_input)
  )
  SELECT
    p.id, p.title, p.description, p.start_datetime, p.end_datetime, p.timezone,
    p.venue_name, p.address, p.city_id, p.latitude, p.longitude,
    p.age_min, p.age_max, p.price, p.is_free,
    p.source_url, p.source_name, p.source_id, p.images, p.status::text,
    p.ai_confidence, p.ai_tag_provider, p.recurrence_info, p.is_featured, p.view_count,
    p.search_vector, p.admin_locked_fields, p.admin_last_edited_at, p.admin_last_edited_by,
    p.created_at, p.updated_at, p.ai_tag_model, p.ai_tag_status,
    p.llm_review_status, p.llm_review_decision, p.llm_review_confidence, p.llm_review_reason,
    p.llm_review_flags, p.llm_review_provider, p.llm_review_model, p.llm_review_prompt_version,
    p.llm_reviewed_at, p.llm_review_error,
    p.total_count
  FROM page p;
END;
$$;

-- Source: 20260610170000_admin_events_source_filter.sql
CREATE OR REPLACE FUNCTION public.admin_events_enriched(
  p_status               text                              DEFAULT NULL::text,
  p_city_id              uuid                              DEFAULT NULL::uuid,
  p_city_is_null         boolean                           DEFAULT NULL::boolean,
  p_keyword              text                              DEFAULT NULL::text,
  p_after_created_at     timestamptz                       DEFAULT NULL::timestamptz,
  p_after_id             uuid                              DEFAULT NULL::uuid,
  p_limit                int                               DEFAULT 50,
  p_llm_review_status    public.llm_event_review_status    DEFAULT NULL::public.llm_event_review_status,
  p_llm_review_decision  public.llm_event_review_decision  DEFAULT NULL::public.llm_event_review_decision,
  p_llm_reviewed         boolean                           DEFAULT NULL::boolean,
  p_source_id            uuid                              DEFAULT NULL::uuid
)
RETURNS TABLE (
  id                    uuid,
  title                 text,
  description           text,
  start_datetime        timestamptz,
  end_datetime          timestamptz,
  timezone              text,
  venue_name            text,
  address               text,
  city_id               uuid,
  latitude              numeric,
  longitude             numeric,
  age_min               int,
  age_max               int,
  price                 numeric,
  is_free               boolean,
  source_url            text,
  source_name           text,
  source_id             uuid,
  images                jsonb,
  status                text,
  ai_confidence         numeric,
  ai_tag_provider       text,
  recurrence_info       jsonb,
  is_featured           boolean,
  view_count            int,
  search_vector         tsvector,
  admin_locked_fields   text[],
  admin_last_edited_at  timestamptz,
  admin_last_edited_by  uuid,
  created_at            timestamptz,
  updated_at            timestamptz,
  ai_tag_model          text,
  ai_tag_status         text,
  llm_review_status     public.llm_event_review_status,
  llm_review_decision   public.llm_event_review_decision,
  llm_review_confidence numeric(4,3),
  llm_review_reason     text,
  llm_review_flags      text[],
  llm_review_provider   text,
  llm_review_model      text,
  llm_review_prompt_version text,
  llm_reviewed_at       timestamptz,
  llm_review_error      text,
  total_count           bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT * FROM private.admin_events_enriched(
    p_status,
    p_city_id,
    p_city_is_null,
    p_keyword,
    p_after_created_at,
    p_after_id,
    p_limit,
    p_llm_review_status,
    p_llm_review_decision,
    p_llm_reviewed,
    p_source_id
  );
$$;

-- Source: 20260902001000_fix_admin_events_enriched_escape.sql
-- Keep the latest admin_events_enriched signature and body intact while
-- correcting the same invalid two-character ILIKE escape fixed for facets in
-- 20260902000000. pg_get_functiondef avoids duplicating the 43-column return
-- contract in another migration.
DO $migration$
DECLARE
  function_signature regprocedure :=
    'private.admin_events_enriched(text,uuid,boolean,text,timestamptz,uuid,integer,public.llm_event_review_status,public.llm_event_review_decision,boolean,uuid)'::regprocedure;
  previous_definition text;
  corrected_definition text;
BEGIN
  SELECT pg_get_functiondef(function_signature) INTO previous_definition;
  corrected_definition := replace(
    previous_definition,
    $old$replace(replace(replace(btrim(p_keyword), '\\', '\\\\'), '%', '\\%'), '_', '\\_')$old$,
    $new$replace(replace(replace(btrim(p_keyword), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_')$new$
  );
  corrected_definition := replace(
    corrected_definition,
    $old$ ESCAPE '\\'$old$,
    $new$ ESCAPE E'\\'$new$
  );

  IF corrected_definition = previous_definition
    OR position($old$ ESCAPE '\\'$old$ IN corrected_definition) > 0
  THEN
    RAISE EXCEPTION 'admin_events_enriched escape patch did not match expected definition';
  END IF;

  EXECUTE corrected_definition;
END;
$migration$;

-- Source: 20260902000000_fix_admin_event_facets_escape.sql
-- PostgreSQL requires ILIKE's ESCAPE expression to contain exactly one
-- character. The previous definition used the standard string '\\', which is
-- two backslashes when standard_conforming_strings is on. Use explicit escape
-- strings so keyword facets can safely match literal %, _, and \ characters.
CREATE OR REPLACE FUNCTION private.admin_event_facets(
  p_keyword text DEFAULT NULL::text
)
RETURNS TABLE (
  city_id uuid,
  source_id uuid,
  status text,
  count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
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
        ELSE replace(
          replace(
            replace(btrim(p_keyword), E'\\', E'\\\\'),
            '%',
            E'\\%'
          ),
          '_',
          E'\\_'
        )
      END AS escaped_kw
  )
  SELECT
    e.city_id,
    e.source_id,
    e.status::text,
    COUNT(*)::bigint AS count
  FROM public.events e
  CROSS JOIN search_input si
  WHERE
    (
      si.kw IS NULL
      OR (
        si.tsq IS NOT NULL
        AND numnode(si.tsq) > 0
        AND e.search_vector @@ si.tsq
      )
      OR (
        si.escaped_kw IS NOT NULL
        AND (si.tsq IS NULL OR numnode(si.tsq) = 0 OR length(si.kw) < 3)
        AND (
          e.title ILIKE '%' || si.escaped_kw || '%' ESCAPE E'\\'
          OR e.description ILIKE '%' || si.escaped_kw || '%' ESCAPE E'\\'
        )
      )
    )
  GROUP BY e.city_id, e.source_id, e.status
  ORDER BY e.city_id, e.source_id, e.status;
END;
$$;

-- Source: 20260610170000_admin_events_source_filter.sql
CREATE OR REPLACE FUNCTION public.admin_event_facets(
  p_keyword text DEFAULT NULL::text
)
RETURNS TABLE (
  city_id uuid,
  source_id uuid,
  status text,
  count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT * FROM private.admin_event_facets(p_keyword);
$$;

-- Source: 20260601021000_admin_event_decisions.sql
CREATE OR REPLACE FUNCTION private.admin_update_event_status(
  p_event_id uuid,
  p_status text,
  p_reason text DEFAULT NULL
)
RETURNS public.events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  before_row public.events%ROWTYPE;
  updated_row public.events%ROWTYPE;
  v_reason text;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_status <> ALL (ARRAY['draft', 'published', 'rejected', 'archived']) THEN
    RAISE EXCEPTION 'invalid event status: %', p_status USING ERRCODE = '22023';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');

  SELECT * INTO before_row
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'event not found: %', p_event_id USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.events
  SET status = p_status::public.event_status,
      updated_at = now(),
      admin_last_edited_at = now(),
      admin_last_edited_by = auth.uid()
  WHERE id = p_event_id
  RETURNING * INTO updated_row;

  -- Record decision if status actually changed
  IF before_row.status IS DISTINCT FROM updated_row.status THEN
    INSERT INTO public.admin_event_decisions (
      event_id, admin_user_id, decision_type,
      old_status, new_status, reason, source_context
    ) VALUES (
      p_event_id,
      auth.uid(),
      'status_change',
      before_row.status,
      updated_row.status,
      v_reason,
      jsonb_build_object('source_id', before_row.source_id, 'source_name', before_row.source_name)
    );
  END IF;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'event.status_change',
    'event',
    p_event_id,
    jsonb_build_object(
      'old_status', before_row.status::text,
      'new_status', p_status,
      'reason', v_reason
    )
  );

  RETURN updated_row;
END;
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql
CREATE OR REPLACE FUNCTION public.admin_update_event_status(
  p_event_id uuid,
  p_status text,
  p_reason text DEFAULT NULL
)
RETURNS public.events
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT * FROM private.admin_update_event_status(p_event_id, p_status, p_reason);
$$;

-- Source: 20260601017000_event_status_enum_and_validate_checks.sql
CREATE OR REPLACE FUNCTION private.admin_batch_set_event_status(p_event_ids uuid[], p_status text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  affected integer;
  previous_rows jsonb;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_EVENT_ADMIN_REQUIRED';
  END IF;

  IF p_status <> ALL (ARRAY['draft', 'published', 'rejected', 'archived']) THEN
    RAISE EXCEPTION 'ADMIN_EVENT_INVALID_STATUS';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)
    INTO previous_rows
    FROM public.events e
   WHERE e.id = ANY (COALESCE(p_event_ids, '{}'::uuid[]));

  UPDATE public.events
     SET status = p_status::public.event_status,
         admin_last_edited_at = now(),
         admin_last_edited_by = auth.uid(),
         updated_at = now()
   WHERE id = ANY (COALESCE(p_event_ids, '{}'::uuid[]));

  GET DIAGNOSTICS affected = ROW_COUNT;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, metadata)
  VALUES (
    auth.uid(),
    'event.status.batch_update',
    'events',
    jsonb_build_object(
      'event_ids', to_jsonb(COALESCE(p_event_ids, '{}'::uuid[])),
      'status', p_status,
      'affected_count', affected,
      'previous', previous_rows
    )
  );

  RETURN affected;
END;
$function$;

-- Source: 20260601003000_maintenance_and_admin_queues.sql
CREATE OR REPLACE FUNCTION public.admin_batch_set_event_status(
  p_event_ids uuid[],
  p_status text
) RETURNS integer
LANGUAGE sql
SET search_path TO ''
AS $$
  SELECT private.admin_batch_set_event_status(p_event_ids, p_status);
$$;

-- Source: 20260601003000_maintenance_and_admin_queues.sql
CREATE OR REPLACE FUNCTION private.admin_delete_events(
  p_event_ids uuid[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  affected integer;
  previous_rows jsonb;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_EVENT_ADMIN_REQUIRED';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)
    INTO previous_rows
    FROM public.events e
   WHERE e.id = ANY (COALESCE(p_event_ids, '{}'::uuid[]));

  DELETE FROM public.events
   WHERE id = ANY (COALESCE(p_event_ids, '{}'::uuid[]));

  GET DIAGNOSTICS affected = ROW_COUNT;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, metadata)
  VALUES (
    auth.uid(),
    'event.delete',
    'events',
    jsonb_build_object(
      'event_ids', to_jsonb(COALESCE(p_event_ids, '{}'::uuid[])),
      'affected_count', affected,
      'previous', previous_rows
    )
  );

  RETURN affected;
END;
$$;

-- Source: 20260601003000_maintenance_and_admin_queues.sql
CREATE OR REPLACE FUNCTION public.admin_delete_events(
  p_event_ids uuid[]
) RETURNS integer
LANGUAGE sql
SET search_path TO ''
AS $$
  SELECT private.admin_delete_events(p_event_ids);
$$;
