-- Roll back admission-cost state while retaining the preceding listing
-- freshness contract. Apply this before the freshness rollback.

DO $rollback$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef(
    'private.admin_update_event(uuid,jsonb,uuid[],boolean,text)'::regprocedure
  ) INTO definition;

  changed := replace(definition, $old$  next_admission_cost_state public.admission_cost_state;
  next_admission_amount numeric;
  next_admission_cost_evidence text;
$old$, '');
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not remove admin variables'; END IF;
  definition := changed;

  changed := regexp_replace(
    definition,
    E'  next_admission_cost_state := CASE.*?  END;\\n  next_admission_amount := CASE.*?  END;\\n  next_admission_cost_evidence := CASE.*?  END;\\n',
    '',
    's'
  );
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not remove admin values'; END IF;
  definition := changed;

  changed := regexp_replace(
    definition,
    E'  IF next_admission_amount IS NOT NULL.*?  END IF;\\n  IF next_admission_cost_state = ''unknown''.*?  END IF;\\n  IF next_admission_cost_state = ''free''.*?  END IF;\\n  IF next_admission_cost_state = ''paid''.*?  END IF;\\n',
    '',
    's'
  );
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not remove admin checks'; END IF;
  definition := changed;

  changed := replace(definition, $old$         admission_cost_state = next_admission_cost_state,
         admission_amount = next_admission_amount,
         admission_cost_evidence = next_admission_cost_evidence,
$old$, '');
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not restore admin update'; END IF;
  EXECUTE changed;
END;
$rollback$;

DO $rollback$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef('private.admin_validate_event_patch(jsonb)'::regprocedure)
    INTO definition;
  changed := replace(definition, $old$    'admission_cost_state',
    'admission_amount',
    'admission_cost_evidence',
$old$, '');
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not restore admin allowlist'; END IF;
  definition := changed;
  changed := regexp_replace(
    definition,
    E'  IF p_patch \\? ''admission_cost_state''.*?  END IF;\\n\\n',
    '',
    's'
  );
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not remove admin validation'; END IF;
  EXECUTE changed;
END;
$rollback$;

DO $rollback$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef(
    'public.events_enriched(uuid,text,uuid,uuid[],timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure
  ) INTO definition;
  changed := regexp_replace(
    definition,
    E'price numeric, is_free boolean, admission_cost_state (public\\.)?admission_cost_state, admission_amount numeric, admission_cost_evidence text, source_url text',
    'price numeric, is_free boolean, source_url text'
  );
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not restore events_enriched row type'; END IF;
  definition := changed;
  changed := replace(
    definition,
    'e.age_min, e.age_max, e.price, e.is_free, e.admission_cost_state, e.admission_amount, e.admission_cost_evidence,',
    'e.age_min, e.age_max, e.price, e.is_free,'
  );
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not restore events_enriched projection'; END IF;
  DROP FUNCTION public.events_enriched(
    uuid, text, uuid, uuid[], timestamptz, timestamptz, timestamptz, uuid, integer
  );
  EXECUTE changed;
END;
$rollback$;

REVOKE ALL ON FUNCTION public.events_enriched(
  uuid, text, uuid, uuid[], timestamptz, timestamptz, timestamptz, uuid, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.events_enriched(
  uuid, text, uuid, uuid[], timestamptz, timestamptz, timestamptz, uuid, integer
) TO anon, authenticated, service_role;

DO $rollback$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef(
    'private.bulk_import_scrape_events(uuid,uuid,jsonb)'::regprocedure
  ) INTO definition;
  changed := regexp_replace(
    definition,
    E'      COALESCE\\(NULLIF\\(elem->>''admission_cost_state'', ''''\\), ''unknown''\\)::public.admission_cost_state\\n                                                   AS admission_cost_state,\\n      NULLIF\\(elem->>''admission_amount'', ''''\\)::numeric AS admission_amount,\\n      NULLIF\\(btrim\\(elem->>''admission_cost_evidence''\\), ''''\\) AS admission_cost_evidence,\\n',
    '',
    's'
  );
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not restore bulk parsing'; END IF;
  definition := changed;
  changed := replace(
    definition,
    'price, is_free, admission_cost_state, admission_amount, admission_cost_evidence, is_outdoor,',
    'price, is_free, is_outdoor,'
  );
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not restore bulk insert columns'; END IF;
  definition := changed;
  changed := replace(
    definition,
    's.price, s.is_free, s.admission_cost_state, s.admission_amount, s.admission_cost_evidence, s.is_outdoor,',
    's.price, s.is_free, s.is_outdoor,'
  );
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not restore bulk insert values'; END IF;
  definition := changed;
  changed := regexp_replace(
    definition,
    E'      admission_cost_state = CASE.*?\\n      admission_amount = CASE.*?\\n      admission_cost_evidence = CASE.*?\\n',
    '',
    's'
  );
  IF changed = definition THEN RAISE EXCEPTION 'admission rollback could not restore bulk update'; END IF;
  EXECUTE changed;
END;
$rollback$;

ALTER TABLE public.events
  DROP CONSTRAINT events_admission_cost_evidence_check,
  DROP COLUMN admission_cost_evidence,
  DROP COLUMN admission_amount,
  DROP COLUMN admission_cost_state;
DROP TYPE public.admission_cost_state;
