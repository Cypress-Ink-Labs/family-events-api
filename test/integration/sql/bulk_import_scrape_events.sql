-- Extracted VERBATIM from family-events-backend migrations for integration tests (U28):
-- - private def: 20260601017000_event_status_enum_and_validate_checks.sql (latest revision)
-- - public wrapper: 20260601002000_event_ingestion_admin_foundation.sql
-- GRANT/REVOKE statements stripped: the bare test database has no anon/
-- authenticated/service_role roles.

CREATE OR REPLACE FUNCTION private.bulk_import_scrape_events(p_run_id uuid, p_source_id uuid, p_events jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_auto_approve   boolean;
  v_processing_mode public.event_processing_mode;
  v_imported       int := 0;
  v_updated        int := 0;
  v_skipped        int := 0;
  v_enqueued       int := 0;
BEGIN
  SELECT
    auto_approve,
    processing_mode
  INTO
    v_auto_approve,
    v_processing_mode
  FROM public.event_sources
  WHERE id = p_source_id;

  IF v_auto_approve IS NULL AND v_processing_mode IS NULL THEN
    RAISE EXCEPTION 'source not found: %', p_source_id USING ERRCODE = 'P0002';
  END IF;

  IF v_processing_mode IS NULL THEN
    v_processing_mode := CASE
      WHEN COALESCE(v_auto_approve, false) THEN 'auto_approve'::public.event_processing_mode
      ELSE 'manual_review'::public.event_processing_mode
    END;
  END IF;

  DROP TABLE IF EXISTS _bulk_input;
  CREATE TEMP TABLE _bulk_input ON COMMIT DROP AS
  WITH inputs AS (
    SELECT
      (idx - 1)::int AS ord,
      (elem->>'title')::text                    AS title,
      (elem->>'description')::text              AS description,
      (elem->>'start_datetime')::timestamptz    AS start_datetime,
      NULLIF(elem->>'end_datetime', '')::timestamptz AS end_datetime,
      (elem->>'timezone')::text                 AS timezone,
      (elem->>'venue_name')::text               AS venue_name,
      (elem->>'address')::text                  AS address,
      NULLIF(elem->>'city_id', '')::uuid        AS city_id,
      NULLIF(elem->>'source_url', '')::text     AS source_url,
      (elem->>'source_name')::text              AS source_name,
      COALESCE(elem->'images', '[]'::jsonb)     AS images,
      NULLIF(elem->>'price', '')::numeric       AS price,
      COALESCE((elem->>'is_free')::boolean, false) AS is_free,
      NULLIF(elem->>'is_outdoor', '')::boolean  AS is_outdoor,
      NULLIF(elem->>'latitude', '')::numeric    AS latitude,
      NULLIF(elem->>'longitude', '')::numeric   AS longitude
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS j(elem, idx)
  ),
  classified AS (
    SELECT
      i.*,
      su.id AS source_url_match
    FROM inputs i
    LEFT JOIN LATERAL (
      SELECT e.id FROM public.events e
      WHERE e.source_id = p_source_id
        AND e.source_url IS NOT NULL
        AND e.source_url = i.source_url
      LIMIT 1
    ) su ON i.source_url IS NOT NULL
  )
  SELECT
    c.*,
    CASE
      WHEN c.source_url_match IS NOT NULL THEN 'update'
      ELSE 'insert'
    END AS decision,
    c.source_url_match AS target_event_id
  FROM classified c;

  DROP TABLE IF EXISTS _bulk_inserted;
  CREATE TEMP TABLE _bulk_inserted ON COMMIT DROP AS
  WITH src AS (
    SELECT * FROM _bulk_input WHERE decision = 'insert'
  ),
  ins AS (
    INSERT INTO public.events (
      title, description, start_datetime, end_datetime, timezone,
      venue_name, address, city_id, latitude, longitude,
      price, is_free, is_outdoor,
      source_url, source_name, source_id,
      images, status,
      llm_review_status,
      llm_review_decision,
      llm_review_confidence,
      llm_review_reason,
      llm_review_flags,
      llm_review_provider,
      llm_review_model,
      llm_review_prompt_version,
      llm_reviewed_at,
      llm_review_error
    )
    SELECT
      s.title, s.description, s.start_datetime, s.end_datetime, s.timezone,
      s.venue_name, s.address, s.city_id, s.latitude, s.longitude,
      s.price, s.is_free, s.is_outdoor,
      s.source_url, s.source_name, p_source_id,
      s.images,
      CASE
        WHEN v_processing_mode = 'auto_approve'::public.event_processing_mode THEN 'published'::public.event_status
        ELSE 'draft'::public.event_status
      END,
      CASE
        WHEN v_processing_mode = 'llm_review'::public.event_processing_mode
          THEN 'pending'::public.llm_event_review_status
        ELSE 'not_required'::public.llm_event_review_status
      END,
      NULL,
      NULL,
      NULL,
      '{}'::text[],
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    FROM src s
    ON CONFLICT (source_id, source_url)
      WHERE source_url IS NOT NULL
      DO NOTHING
    RETURNING id, source_url
  )
  SELECT id, source_url FROM ins;

  GET DIAGNOSTICS v_imported = ROW_COUNT;

  DROP TABLE IF EXISTS _bulk_update_targets;
  CREATE TEMP TABLE _bulk_update_targets ON COMMIT DROP AS
  SELECT b.*, e.id AS event_id, e.admin_locked_fields
  FROM _bulk_input b
  JOIN public.events e
    ON e.source_id = p_source_id
   AND e.source_url IS NOT NULL
   AND e.source_url = b.source_url
  WHERE b.decision = 'update'
     OR (b.decision = 'insert' AND b.source_url IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM _bulk_inserted i WHERE i.source_url = b.source_url));

  WITH updated AS (
    UPDATE public.events e SET
      title          = CASE WHEN 'title'          = ANY(e.admin_locked_fields) THEN e.title          ELSE t.title          END,
      description    = CASE WHEN 'description'    = ANY(e.admin_locked_fields) THEN e.description    ELSE t.description    END,
      start_datetime = CASE WHEN 'start_datetime' = ANY(e.admin_locked_fields) THEN e.start_datetime ELSE t.start_datetime END,
      end_datetime   = CASE WHEN 'end_datetime'   = ANY(e.admin_locked_fields) THEN e.end_datetime   ELSE t.end_datetime   END,
      timezone       = CASE WHEN 'timezone'       = ANY(e.admin_locked_fields) THEN e.timezone       ELSE t.timezone       END,
      venue_name     = CASE WHEN 'venue_name'     = ANY(e.admin_locked_fields) THEN e.venue_name     ELSE t.venue_name     END,
      address        = CASE WHEN 'address'        = ANY(e.admin_locked_fields) THEN e.address        ELSE t.address        END,
      city_id        = CASE WHEN 'city_id'        = ANY(e.admin_locked_fields) THEN e.city_id        ELSE t.city_id        END,
      source_url     = CASE WHEN 'source_url'     = ANY(e.admin_locked_fields) THEN e.source_url     ELSE t.source_url     END,
      source_name    = CASE WHEN 'source_name'    = ANY(e.admin_locked_fields) THEN e.source_name    ELSE t.source_name    END,
      source_id      = CASE WHEN 'source_id'      = ANY(e.admin_locked_fields) THEN e.source_id      ELSE p_source_id      END,
      images         = CASE WHEN 'images'         = ANY(e.admin_locked_fields) THEN e.images         ELSE t.images         END,
      price          = CASE WHEN 'price'          = ANY(e.admin_locked_fields) THEN e.price          ELSE t.price          END,
      is_free        = CASE WHEN 'is_free'        = ANY(e.admin_locked_fields) THEN e.is_free        ELSE t.is_free        END,
      is_outdoor     = CASE WHEN 'is_outdoor'     = ANY(e.admin_locked_fields) THEN e.is_outdoor     ELSE t.is_outdoor     END,
      llm_review_status = CASE
        WHEN v_processing_mode = 'llm_review'::public.event_processing_mode
          THEN 'pending'::public.llm_event_review_status
        ELSE 'not_required'::public.llm_event_review_status
      END,
      llm_review_decision = NULL,
      llm_review_confidence = NULL,
      llm_review_reason = NULL,
      llm_review_flags = '{}'::text[],
      llm_review_provider = NULL,
      llm_review_model = NULL,
      llm_review_prompt_version = NULL,
      llm_reviewed_at = NULL,
      llm_review_error = NULL,
      updated_at     = now()
    FROM _bulk_update_targets t
    WHERE e.id = t.event_id
    RETURNING e.id
  )
  SELECT COUNT(*) INTO v_updated FROM updated;

  WITH all_imported AS (
    SELECT id FROM _bulk_inserted
    UNION ALL
    SELECT event_id AS id FROM _bulk_update_targets
  ),
  enq AS (
    INSERT INTO public.event_llm_review_queue (event_id, source_id, source_run_id, trigger_type)
    SELECT id, p_source_id, p_run_id, 'import'
    FROM all_imported
    WHERE v_processing_mode = 'llm_review'::public.event_processing_mode
    ON CONFLICT (event_id) WHERE status IN ('pending', 'processing', 'retrying')
      DO NOTHING
    RETURNING id
  ),
  tag_enq AS (
    INSERT INTO public.event_tag_queue (event_id, source_run_id, trigger_type)
    SELECT id, p_run_id, 'import'
    FROM all_imported
    WHERE v_processing_mode <> 'llm_review'::public.event_processing_mode
    ON CONFLICT (event_id) WHERE status IN ('pending', 'processing')
      DO NOTHING
    RETURNING id
  )
  SELECT
    COALESCE((SELECT COUNT(*) FROM enq), 0) + COALESCE((SELECT COUNT(*) FROM tag_enq), 0)
  INTO v_enqueued;

  RETURN jsonb_build_object(
    'imported', v_imported,
    'updated',  v_updated,
    'skipped',  v_skipped,
    'enqueued', v_enqueued
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bulk_import_scrape_events(
  p_run_id    uuid,
  p_source_id uuid,
  p_events    jsonb
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.bulk_import_scrape_events(p_run_id, p_source_id, p_events);
$$;

