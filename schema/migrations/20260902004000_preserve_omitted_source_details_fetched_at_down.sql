-- Restore the previous behavior where omission and explicit null both clear
-- source_details_fetched_at during same-source updates.
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
    'source_details_fetched_at = CASE WHEN t.has_source_details_fetched_at THEN t.source_details_fetched_at ELSE e.source_details_fetched_at END,',
    'source_details_fetched_at = t.source_details_fetched_at,'
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'freshness-preservation rollback could not restore bulk assignment';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$      NULLIF(elem->>'source_details_fetched_at', '')::timestamptz
                                                   AS source_details_fetched_at,
      elem ? 'source_details_fetched_at'            AS has_source_details_fetched_at,
$old$,
    $new$      NULLIF(elem->>'source_details_fetched_at', '')::timestamptz
                                                   AS source_details_fetched_at,
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'freshness-preservation rollback could not remove bulk payload marker';
  END IF;

  EXECUTE changed;
END;
$migration$;
