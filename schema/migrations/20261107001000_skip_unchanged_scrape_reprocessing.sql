-- Queue a matched event for AI only when the content its AI step reads
-- changed or its last AI result was a failure or fallback. An unchanged event
-- keeps its review state and the venue, price and free flag tagging filled in;
-- a changed title or description clears its stored tagging success.
DO $migration$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef(
    'private.bulk_import_scrape_events(uuid,uuid,jsonb)'::regprocedure
  ) INTO definition;

  changed := replace(
    definition,
    $old$  SELECT b.*, e.id AS event_id, e.admin_locked_fields
  FROM _bulk_input b
$old$,
    $new$  SELECT b.*, e.id AS event_id, e.admin_locked_fields,
    CASE
      WHEN v_processing_mode = 'llm_review'::public.event_processing_mode THEN
        e.status = 'draft'::public.event_status
        AND (
          e.llm_review_status IN (
            'pending'::public.llm_event_review_status,
            'failed'::public.llm_event_review_status
          )
          OR ('title' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.title IS DISTINCT FROM e.title)
          OR ('description' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.description IS DISTINCT FROM e.description)
          OR ('start_datetime' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.start_datetime IS DISTINCT FROM e.start_datetime)
          OR ('end_datetime' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.end_datetime IS DISTINCT FROM e.end_datetime)
          OR ('timezone' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.timezone IS DISTINCT FROM e.timezone)
          OR ('venue_name' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.venue_name IS NOT NULL AND b.venue_name IS DISTINCT FROM e.venue_name)
          OR ('address' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.address IS DISTINCT FROM e.address)
          OR ('source_name' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.source_name IS DISTINCT FROM e.source_name)
        )
      ELSE
        e.ai_tag_status IS DISTINCT FROM 'success'
        OR ('title' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.title IS DISTINCT FROM e.title)
        OR ('description' <> ALL(COALESCE(e.admin_locked_fields, '{}'::text[])) AND b.description IS DISTINCT FROM e.description)
    END AS reprocess
  FROM _bulk_input b
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'reprocess migration could not extend bulk update targets';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$      llm_review_status = CASE
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
$old$,
    $new$      ai_tag_status = CASE
        WHEN t.reprocess AND e.ai_tag_status = 'success'
          AND v_processing_mode <> 'llm_review'::public.event_processing_mode
          THEN NULL
        ELSE e.ai_tag_status
      END,
      llm_review_status = CASE
        WHEN NOT t.reprocess THEN e.llm_review_status
        WHEN v_processing_mode = 'llm_review'::public.event_processing_mode
          THEN 'pending'::public.llm_event_review_status
        ELSE 'not_required'::public.llm_event_review_status
      END,
      llm_review_decision = CASE WHEN t.reprocess THEN NULL ELSE e.llm_review_decision END,
      llm_review_confidence = CASE WHEN t.reprocess THEN NULL ELSE e.llm_review_confidence END,
      llm_review_reason = CASE WHEN t.reprocess THEN NULL ELSE e.llm_review_reason END,
      llm_review_flags = CASE WHEN t.reprocess THEN '{}'::text[] ELSE e.llm_review_flags END,
      llm_review_provider = CASE WHEN t.reprocess THEN NULL ELSE e.llm_review_provider END,
      llm_review_model = CASE WHEN t.reprocess THEN NULL ELSE e.llm_review_model END,
      llm_review_prompt_version = CASE WHEN t.reprocess THEN NULL ELSE e.llm_review_prompt_version END,
      llm_reviewed_at = CASE WHEN t.reprocess THEN NULL ELSE e.llm_reviewed_at END,
      llm_review_error = CASE WHEN t.reprocess THEN NULL ELSE e.llm_review_error END,
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'reprocess migration could not guard the review state reset';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$      venue_name     = CASE WHEN 'venue_name'     = ANY(e.admin_locked_fields) THEN e.venue_name     ELSE t.venue_name     END,
$old$,
    $new$      venue_name     = CASE WHEN 'venue_name'     = ANY(e.admin_locked_fields) THEN e.venue_name     WHEN t.reprocess THEN t.venue_name ELSE COALESCE(t.venue_name, e.venue_name) END,
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'reprocess migration could not protect the tagged venue';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$      price          = CASE WHEN 'price'          = ANY(e.admin_locked_fields) THEN e.price          ELSE t.price          END,
      is_free        = CASE WHEN 'is_free'        = ANY(e.admin_locked_fields) THEN e.is_free        ELSE t.is_free        END,
$old$,
    $new$      price          = CASE WHEN 'price'          = ANY(e.admin_locked_fields) THEN e.price          WHEN t.reprocess THEN t.price ELSE COALESCE(t.price, e.price) END,
      is_free        = CASE WHEN 'is_free'        = ANY(e.admin_locked_fields) THEN e.is_free        WHEN t.reprocess THEN t.is_free ELSE t.is_free OR (COALESCE(e.is_free, false) AND t.price IS NULL) END,
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'reprocess migration could not protect the tagged price';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$    SELECT event_id AS id FROM _bulk_update_targets
$old$,
    $new$    SELECT event_id AS id FROM _bulk_update_targets WHERE reprocess
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'reprocess migration could not filter the enqueue set';
  END IF;

  EXECUTE changed;
END;
$migration$;
