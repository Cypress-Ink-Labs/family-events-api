DO $rollback$
DECLARE
  original text;
  patched text;
  current_definition text;
BEGIN
  SELECT original_definition, patched_definition INTO STRICT original, patched
  FROM private.api_admin_editor_status_rollback WHERE singleton;
  SELECT pg_get_functiondef(
    'private.admin_update_event(uuid,jsonb,uuid[],boolean,text)'::regprocedure
  ) INTO current_definition;
  IF current_definition <> patched THEN
    RAISE EXCEPTION 'admin editor status rollback blocked: function changed after migration';
  END IF;
  EXECUTE original;
END;
$rollback$;
DROP TABLE private.api_admin_editor_status_rollback;
