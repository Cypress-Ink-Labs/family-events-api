CREATE TABLE private.api_admin_queue_count_rollback (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  original_definition text NOT NULL,
  patched_definition text NOT NULL
);
REVOKE ALL ON TABLE private.api_admin_queue_count_rollback FROM PUBLIC;

DO $migration$
DECLARE
  definition text;
  changed text;
  original constant text := 'base_count AS (';
  materialized constant text := 'base_count AS MATERIALIZED (';
BEGIN
  SELECT pg_get_functiondef(
    'private.admin_events_enriched(text,uuid,boolean,text,timestamptz,uuid,integer,public.llm_event_review_status,public.llm_event_review_decision,boolean,uuid)'::regprocedure
  ) INTO definition;
  IF strpos(definition, original) > 0 THEN
    IF (length(definition) - length(replace(definition, original, ''))) <> length(original) THEN
      RAISE EXCEPTION 'admin queue count migration found multiple count expressions';
    END IF;
    changed := replace(definition, original, materialized);
  ELSIF strpos(definition, materialized) > 0 THEN
    changed := definition;
  ELSE
    RAISE EXCEPTION 'admin queue count migration found an unknown count expression';
  END IF;
  INSERT INTO private.api_admin_queue_count_rollback(original_definition, patched_definition)
  VALUES (definition, changed);
  IF changed <> definition THEN
    EXECUTE changed;
  END IF;
END;
$migration$;
