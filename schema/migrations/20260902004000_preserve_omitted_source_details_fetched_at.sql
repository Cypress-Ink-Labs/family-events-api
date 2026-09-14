-- Distinguish an omitted freshness key from an explicit JSON null during
-- same-source updates. Inserts retain the existing NULL default.
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
    $old$      NULLIF(elem->>'source_details_fetched_at', '')::timestamptz
                                                   AS source_details_fetched_at,
$old$,
    $new$      NULLIF(elem->>'source_details_fetched_at', '')::timestamptz
                                                   AS source_details_fetched_at,
      elem ? 'source_details_fetched_at'            AS has_source_details_fetched_at,
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'freshness-preservation migration could not extend bulk payload parsing';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    'source_details_fetched_at = t.source_details_fetched_at,',
    'source_details_fetched_at = CASE WHEN t.has_source_details_fetched_at THEN t.source_details_fetched_at ELSE e.source_details_fetched_at END,'
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'freshness-preservation migration could not update bulk assignment';
  END IF;

  EXECUTE changed;
END;
$migration$;
