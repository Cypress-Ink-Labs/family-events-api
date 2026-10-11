CREATE TABLE private.api_admin_editor_status_rollback (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  original_definition text NOT NULL,
  patched_definition text NOT NULL
);
REVOKE ALL ON TABLE private.api_admin_editor_status_rollback FROM PUBLIC;

DO $migration$
DECLARE
  definition text;
  changed text;
  untyped constant text := $expression$status = CASE WHEN patch ? 'status' THEN patch->>'status' ELSE status END$expression$;
  typed constant text := $expression$status = CASE WHEN patch ? 'status' THEN (patch->>'status')::public.event_status ELSE status END$expression$;
BEGIN
  SELECT pg_get_functiondef(
    'private.admin_update_event(uuid,jsonb,uuid[],boolean,text)'::regprocedure
  ) INTO definition;

  IF strpos(definition, untyped) > 0 THEN
    IF (length(definition) - length(replace(definition, untyped, ''))) <> length(untyped) THEN
      RAISE EXCEPTION 'admin editor status migration found multiple untyped assignments';
    END IF;
    changed := replace(definition, untyped, typed);
  ELSIF strpos(definition, typed) > 0 THEN
    changed := definition;
  ELSE
    RAISE EXCEPTION 'admin editor status migration found an unknown assignment';
  END IF;

  INSERT INTO private.api_admin_editor_status_rollback(original_definition, patched_definition)
  VALUES (definition, changed);
  IF changed <> definition THEN
    EXECUTE changed;
  END IF;
END;
$migration$;
