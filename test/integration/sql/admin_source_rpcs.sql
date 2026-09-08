-- Production definitions copied from family-events-backend:
-- admin_create_source and public create/update wrappers from
-- 20260601003000_maintenance_and_admin_queues.sql;
-- latest admin_update_source and processing-mode functions/wrappers
-- from 20260601004000_llm_review_and_enrichment.sql;
-- enqueue_source_scrape from 20260610162002_enqueue_source_scrape_rpc.sql.

CREATE OR REPLACE FUNCTION private.admin_create_source(
  p_source jsonb
) RETURNS public.event_sources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  source_payload jsonb := COALESCE(p_source, '{}'::jsonb);
  created_row public.event_sources%ROWTYPE;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_SOURCE_ADMIN_REQUIRED';
  END IF;

  IF NULLIF(btrim(source_payload->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'ADMIN_SOURCE_NAME_REQUIRED';
  END IF;

  IF NULLIF(btrim(source_payload->>'url'), '') IS NULL THEN
    RAISE EXCEPTION 'ADMIN_SOURCE_URL_REQUIRED';
  END IF;

  INSERT INTO public.event_sources (
    name,
    url,
    source_type,
    extraction_mode,
    city_id,
    is_active,
    auto_approve,
    scrape_interval_hours,
    last_scraped_at,
    last_status,
    error_count,
    notes,
    date_window_days
  )
  VALUES (
    btrim(source_payload->>'name'),
    btrim(source_payload->>'url'),
    COALESCE(NULLIF(btrim(source_payload->>'source_type'), ''), 'website'),
    COALESCE(NULLIF(btrim(source_payload->>'extraction_mode'), ''), 'deterministic')::public.source_extraction_mode,
    CASE
      WHEN source_payload ? 'city_id' AND jsonb_typeof(source_payload->'city_id') <> 'null' AND NULLIF(btrim(source_payload->>'city_id'), '') IS NOT NULL
        THEN (source_payload->>'city_id')::uuid
      ELSE NULL
    END,
    COALESCE((source_payload->>'is_active')::boolean, true),
    COALESCE((source_payload->>'auto_approve')::boolean, false),
    COALESCE((source_payload->>'scrape_interval_hours')::integer, 24),
    CASE
      WHEN source_payload ? 'last_scraped_at' AND jsonb_typeof(source_payload->'last_scraped_at') <> 'null'
        THEN (source_payload->>'last_scraped_at')::timestamptz
      ELSE NULL
    END,
    COALESCE(NULLIF(btrim(source_payload->>'last_status'), ''), 'pending'),
    COALESCE((source_payload->>'error_count')::integer, 0),
    CASE
      WHEN source_payload ? 'notes' AND jsonb_typeof(source_payload->'notes') <> 'null'
        THEN source_payload->>'notes'
      ELSE NULL
    END,
    CASE
      WHEN source_payload ? 'date_window_days' AND jsonb_typeof(source_payload->'date_window_days') <> 'null'
        THEN (source_payload->>'date_window_days')::integer
      ELSE NULL
    END
  )
  RETURNING * INTO created_row;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'source.create',
    'event_source',
    created_row.id,
    jsonb_build_object('source', to_jsonb(created_row))
  );

  RETURN created_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_source(
  p_source jsonb
) RETURNS public.event_sources
LANGUAGE sql
SET search_path TO ''
AS $$
  SELECT * FROM private.admin_create_source(p_source);
$$;

CREATE OR REPLACE FUNCTION private.admin_update_source(
  p_source_id uuid,
  p_patch jsonb
) RETURNS public.event_sources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  patch jsonb := COALESCE(p_patch, '{}'::jsonb);
  before_row public.event_sources%ROWTYPE;
  updated_row public.event_sources%ROWTYPE;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_SOURCE_ADMIN_REQUIRED';
  END IF;

  IF patch ? 'name' AND NULLIF(btrim(patch->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'ADMIN_SOURCE_NAME_REQUIRED';
  END IF;

  IF patch ? 'url' AND NULLIF(btrim(patch->>'url'), '') IS NULL THEN
    RAISE EXCEPTION 'ADMIN_SOURCE_URL_REQUIRED';
  END IF;

  SELECT *
    INTO before_row
    FROM public.event_sources
   WHERE id = p_source_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMIN_SOURCE_NOT_FOUND';
  END IF;

  UPDATE public.event_sources
     SET name = CASE WHEN patch ? 'name' THEN btrim(patch->>'name') ELSE name END,
         url = CASE WHEN patch ? 'url' THEN btrim(patch->>'url') ELSE url END,
         source_type = CASE WHEN patch ? 'source_type' THEN patch->>'source_type' ELSE source_type END,
         extraction_mode = CASE WHEN patch ? 'extraction_mode' THEN (patch->>'extraction_mode')::public.source_extraction_mode ELSE extraction_mode END,
         processing_mode = CASE WHEN patch ? 'processing_mode' THEN (patch->>'processing_mode')::public.event_processing_mode ELSE processing_mode END,
         city_id = CASE
           WHEN patch ? 'city_id' AND jsonb_typeof(patch->'city_id') = 'null' THEN NULL
           WHEN patch ? 'city_id' AND NULLIF(btrim(patch->>'city_id'), '') IS NULL THEN NULL
           WHEN patch ? 'city_id' THEN (patch->>'city_id')::uuid
           ELSE city_id
         END,
         is_active = CASE WHEN patch ? 'is_active' THEN (patch->>'is_active')::boolean ELSE is_active END,
         auto_approve = CASE WHEN patch ? 'auto_approve' THEN (patch->>'auto_approve')::boolean ELSE auto_approve END,
         scrape_interval_hours = CASE WHEN patch ? 'scrape_interval_hours' THEN (patch->>'scrape_interval_hours')::integer ELSE scrape_interval_hours END,
         last_scraped_at = CASE
           WHEN patch ? 'last_scraped_at' AND jsonb_typeof(patch->'last_scraped_at') = 'null' THEN NULL
           WHEN patch ? 'last_scraped_at' THEN (patch->>'last_scraped_at')::timestamptz
           ELSE last_scraped_at
         END,
         last_status = CASE
           WHEN patch ? 'last_status' AND jsonb_typeof(patch->'last_status') = 'null' THEN NULL
           WHEN patch ? 'last_status' THEN patch->>'last_status'
           ELSE last_status
         END,
         error_count = CASE WHEN patch ? 'error_count' THEN (patch->>'error_count')::integer ELSE error_count END,
         notes = CASE
           WHEN patch ? 'notes' AND jsonb_typeof(patch->'notes') = 'null' THEN NULL
           WHEN patch ? 'notes' THEN patch->>'notes'
           ELSE notes
         END,
         date_window_days = CASE
           WHEN patch ? 'date_window_days' AND jsonb_typeof(patch->'date_window_days') = 'null' THEN NULL
           WHEN patch ? 'date_window_days' THEN (patch->>'date_window_days')::integer
           ELSE date_window_days
         END,
         updated_at = now()
   WHERE id = p_source_id
   RETURNING * INTO updated_row;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'source.update',
    'event_source',
    p_source_id,
    jsonb_build_object('previous', to_jsonb(before_row), 'patch', patch)
  );

  RETURN updated_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_source(
  p_source_id uuid,
  p_patch jsonb
) RETURNS public.event_sources
LANGUAGE sql
SET search_path TO ''
AS $$
  SELECT * FROM private.admin_update_source(p_source_id, p_patch);
$$;

CREATE OR REPLACE FUNCTION private.admin_set_event_source_processing_mode(
  p_source_id uuid,
  p_mode public.event_processing_mode
)
RETURNS public.event_sources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  before_row public.event_sources%ROWTYPE;
  updated_row public.event_sources%ROWTYPE;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO before_row
  FROM public.event_sources
  WHERE id = p_source_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source not found: %', p_source_id USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.event_sources
  SET processing_mode = p_mode,
      auto_approve = (p_mode = 'auto_approve'::public.event_processing_mode),
      updated_at = now()
  WHERE id = p_source_id
  RETURNING * INTO updated_row;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'source.processing_mode.update',
    'event_source',
    p_source_id,
    jsonb_build_object(
      'previous_processing_mode', before_row.processing_mode::text,
      'processing_mode', p_mode::text,
      'previous_auto_approve', before_row.auto_approve,
      'auto_approve', updated_row.auto_approve
    )
  );

  RETURN updated_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_event_source_processing_mode(
  p_source_id uuid,
  p_mode public.event_processing_mode
)
RETURNS public.event_sources
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT * FROM private.admin_set_event_source_processing_mode(p_source_id, p_mode);
$$;

CREATE OR REPLACE FUNCTION private.admin_bulk_set_processing_mode(
  p_mode public.event_processing_mode
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  affected integer;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE public.event_sources
  SET processing_mode = p_mode,
      auto_approve = (p_mode = 'auto_approve'::public.event_processing_mode),
      updated_at = now()
  WHERE id IS NOT NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, metadata)
  VALUES (
    auth.uid(),
    'bulk_set_processing_mode',
    'event_sources',
    jsonb_build_object('processing_mode', p_mode::text, 'affected_count', affected)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_bulk_set_processing_mode(
  p_mode public.event_processing_mode
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT private.admin_bulk_set_processing_mode(p_mode);
$$;

CREATE OR REPLACE FUNCTION private.enqueue_source_scrape(
  p_source_id uuid,
  p_trigger_type text DEFAULT 'manual'
)
RETURNS TABLE(queue_id bigint, deduped boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_inserted_id bigint;
  v_existing_id bigint;
BEGIN
  IF p_trigger_type IS NULL
    OR p_trigger_type <> ALL (ARRAY['manual', 'scheduled', 'bulk', 'retry'])
  THEN
    RAISE EXCEPTION 'invalid source scrape trigger type: %', p_trigger_type
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.source_scrape_queue (source_id, trigger_type)
  VALUES (p_source_id, p_trigger_type)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    queue_id := v_inserted_id;
    deduped := false;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT id
  INTO v_existing_id
  FROM public.source_scrape_queue
  WHERE source_id = p_source_id
    AND status IN ('pending', 'processing', 'retrying')
  ORDER BY enqueued_at ASC, id ASC
  LIMIT 1;

  queue_id := v_existing_id;
  deduped := true;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_source_scrape(
  p_source_id uuid,
  p_trigger_type text DEFAULT 'manual'
)
RETURNS TABLE(queue_id bigint, deduped boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT *
  FROM private.enqueue_source_scrape(p_source_id, p_trigger_type);
$$;
