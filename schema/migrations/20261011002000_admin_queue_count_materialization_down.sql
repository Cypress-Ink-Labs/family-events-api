DO $rollback$
DECLARE
  original text;
  patched text;
  current_definition text;
BEGIN
  SELECT original_definition, patched_definition INTO STRICT original, patched
  FROM private.api_admin_queue_count_rollback WHERE singleton;
  SELECT pg_get_functiondef(
    'private.admin_events_enriched(text,uuid,boolean,text,timestamptz,uuid,integer,public.llm_event_review_status,public.llm_event_review_decision,boolean,uuid)'::regprocedure
  ) INTO current_definition;
  IF current_definition <> patched THEN
    RAISE EXCEPTION 'admin queue count rollback blocked: function changed after migration';
  END IF;
  EXECUTE original;
END;
$rollback$;
DROP TABLE private.api_admin_queue_count_rollback;
