-- Production-derived disposable fixture.
-- Sources:
-- family-events-backend/supabase/migrations/20260601024000_admin_retry_dead_tag_queue.sql
-- family-events-backend/supabase/migrations/20260601003000_maintenance_and_admin_queues.sql
-- Do not simplify: these private/public functions preserve production authorization,
-- conflict handling, source-row retention, tag-row removal, and ownership.
-- Production grants are trimmed because the disposable server has no
-- authenticated or service_role roles.

CREATE OR REPLACE FUNCTION private.admin_retry_source_scrape_queue(p_queue_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
  v_source_id uuid;
  v_has_active boolean;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT source_id INTO v_source_id
  FROM public.source_scrape_queue
  WHERE id = p_queue_id AND status = 'dead';
  IF v_source_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.source_scrape_queue (source_id, trigger_type)
  VALUES (v_source_id, 'retry') ON CONFLICT DO NOTHING;
  SELECT EXISTS (
    SELECT 1 FROM public.source_scrape_queue
    WHERE source_id = v_source_id AND status IN ('pending', 'processing', 'retrying')
  ) INTO v_has_active;
  RETURN v_has_active;
END;
$$;
ALTER FUNCTION private.admin_retry_source_scrape_queue(bigint) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.admin_retry_source_scrape_queue(p_queue_id bigint)
RETURNS boolean LANGUAGE sql SET search_path TO ''
AS $$ SELECT private.admin_retry_source_scrape_queue(p_queue_id); $$;
ALTER FUNCTION public.admin_retry_source_scrape_queue(bigint) OWNER TO postgres;

CREATE OR REPLACE FUNCTION private.admin_retry_dead_tag_queue(p_queue_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
  v_event_id uuid;
  v_source_run_id uuid;
  v_has_active boolean;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT event_id, source_run_id INTO v_event_id, v_source_run_id
  FROM public.event_tag_queue
  WHERE id = p_queue_id AND status = 'dead';
  IF v_event_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.event_tag_queue (event_id, source_run_id, trigger_type)
  VALUES (v_event_id, v_source_run_id, 'manual-review')
  ON CONFLICT DO NOTHING;
  SELECT EXISTS (
    SELECT 1 FROM public.event_tag_queue
    WHERE event_id = v_event_id AND status IN ('pending','processing')
  ) INTO v_has_active;
  IF v_has_active THEN
    DELETE FROM public.event_tag_queue WHERE id = p_queue_id AND status = 'dead';
  END IF;
  RETURN v_has_active;
END;
$$;
ALTER FUNCTION private.admin_retry_dead_tag_queue(bigint) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.admin_retry_dead_tag_queue(p_queue_id bigint)
RETURNS boolean LANGUAGE sql SET search_path TO ''
AS $$ SELECT private.admin_retry_dead_tag_queue(p_queue_id); $$;
ALTER FUNCTION public.admin_retry_dead_tag_queue(bigint) OWNER TO postgres;

CREATE OR REPLACE FUNCTION private.admin_delete_dead_source_queue(p_queue_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_deleted int;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.source_scrape_queue WHERE id = p_queue_id AND status = 'dead';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;
ALTER FUNCTION private.admin_delete_dead_source_queue(bigint) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.admin_delete_dead_source_queue(p_queue_id bigint)
RETURNS boolean LANGUAGE sql SET search_path TO ''
AS $$ SELECT private.admin_delete_dead_source_queue(p_queue_id); $$;
ALTER FUNCTION public.admin_delete_dead_source_queue(bigint) OWNER TO postgres;

CREATE OR REPLACE FUNCTION private.admin_delete_dead_tag_queue(p_queue_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_deleted int;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.event_tag_queue WHERE id = p_queue_id AND status = 'dead';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;
ALTER FUNCTION private.admin_delete_dead_tag_queue(bigint) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.admin_delete_dead_tag_queue(p_queue_id bigint)
RETURNS boolean LANGUAGE sql SET search_path TO ''
AS $$ SELECT private.admin_delete_dead_tag_queue(p_queue_id); $$;
ALTER FUNCTION public.admin_delete_dead_tag_queue(bigint) OWNER TO postgres;

