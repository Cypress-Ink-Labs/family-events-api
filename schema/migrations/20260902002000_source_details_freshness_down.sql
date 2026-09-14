-- Rollback for 20260902002000_source_details_freshness.sql.
--
-- Restore both function definitions before dropping the column. The strict
-- replacements deliberately fail rather than silently losing unrelated RPC
-- improvements. DROP FUNCTION never uses CASCADE, and the public RPC's grants
-- are restored after its declared row type is recreated.

DO $rollback$
DECLARE
  current_definition text;
  prior_definition text;
  next_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'private.bulk_import_scrape_events(uuid,uuid,jsonb)'::regprocedure
  ) INTO current_definition;

  next_definition := replace(
    current_definition,
    $old$      NULLIF(elem->>'source_details_fetched_at', '')::timestamptz
                                                   AS source_details_fetched_at,
$old$,
    ''
  );
  IF next_definition = current_definition THEN
    RAISE EXCEPTION 'bulk import rollback could not remove freshness payload cast';
  END IF;
  prior_definition := next_definition;

  next_definition := replace(
    prior_definition,
    'source_url, source_name, source_details_fetched_at, source_id,',
    'source_url, source_name, source_id,'
  );
  IF next_definition = prior_definition THEN
    RAISE EXCEPTION 'bulk import rollback could not restore insert columns';
  END IF;
  prior_definition := next_definition;

  next_definition := replace(
    prior_definition,
    's.source_url, s.source_name, s.source_details_fetched_at, p_source_id,',
    's.source_url, s.source_name, p_source_id,'
  );
  IF next_definition = prior_definition THEN
    RAISE EXCEPTION 'bulk import rollback could not restore insert projection';
  END IF;
  prior_definition := next_definition;

  next_definition := replace(
    prior_definition,
    $old$      source_details_fetched_at = t.source_details_fetched_at,
$old$,
    ''
  );
  IF next_definition = prior_definition
     OR position('source_details_fetched_at' IN next_definition) > 0
  THEN
    RAISE EXCEPTION 'bulk import rollback could not restore update projection';
  END IF;

  EXECUTE next_definition;
END;
$rollback$;

DO $rollback$
DECLARE
  current_definition text;
  prior_definition text;
  next_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.events_enriched(uuid,text,uuid,uuid[],timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure
  ) INTO current_definition;

  next_definition := replace(
    current_definition,
    'source_name text, source_details_fetched_at timestamp with time zone, source_id uuid',
    'source_name text, source_id uuid'
  );
  IF next_definition = current_definition THEN
    RAISE EXCEPTION 'events_enriched rollback could not restore declared row type';
  END IF;
  prior_definition := next_definition;

  next_definition := replace(
    prior_definition,
    'e.source_url, e.source_name, e.source_details_fetched_at, e.source_id,',
    'e.source_url, e.source_name, e.source_id,'
  );
  IF next_definition = prior_definition
     OR position('source_details_fetched_at' IN next_definition) > 0
  THEN
    RAISE EXCEPTION 'events_enriched rollback could not restore projection';
  END IF;

  EXECUTE 'DROP FUNCTION public.events_enriched(
    uuid, text, uuid, uuid[], timestamptz, timestamptz, timestamptz, uuid, integer
  )';
  EXECUTE next_definition;
END;
$rollback$;

REVOKE ALL ON FUNCTION public.events_enriched(
  uuid, text, uuid, uuid[], timestamptz, timestamptz, timestamptz, uuid, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.events_enriched(
  uuid, text, uuid, uuid[], timestamptz, timestamptz, timestamptz, uuid, integer
) TO anon, authenticated, service_role;

ALTER TABLE public.events
  DROP COLUMN source_details_fetched_at;
