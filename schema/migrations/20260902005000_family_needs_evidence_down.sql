DROP VIEW IF EXISTS public.event_family_needs;
DROP FUNCTION IF EXISTS private.import_family_need_statements(uuid, jsonb);
DROP TRIGGER IF EXISTS invalidate_material_family_need_evidence ON public.events;
DROP FUNCTION IF EXISTS private.invalidate_material_family_need_evidence();
DROP TABLE IF EXISTS public.event_family_need_evidence;
DROP TYPE IF EXISTS public.family_need_provenance;
DROP TYPE IF EXISTS public.family_need_value;
DROP TYPE IF EXISTS public.family_need_claim;
DO $migration$
DECLARE definition text; changed text;
BEGIN
  SELECT pg_get_functiondef('private.bulk_import_scrape_events(uuid,uuid,jsonb)'::regprocedure) INTO definition;
  changed := replace(definition,
    $remove$      NULLIF(btrim(elem->>'parking_details'), '') AS parking_details,
      NULLIF(btrim(elem->>'reservation_details'), '') AS reservation_details,
$remove$,
    '');
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: bulk parsing replacement failed'; END IF;
  definition := changed;
  changed := replace(definition, 'admission_cost_evidence, parking_details, reservation_details, is_outdoor,', 'admission_cost_evidence, is_outdoor,');
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: bulk columns replacement failed'; END IF;
  definition := changed;
  changed := replace(definition, 's.admission_cost_evidence, s.parking_details, s.reservation_details, s.is_outdoor,', 's.admission_cost_evidence, s.is_outdoor,');
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: bulk values replacement failed'; END IF;
  definition := changed;
  changed := replace(definition,
    $remove$      parking_details = CASE WHEN 'parking_details' = ANY(e.admin_locked_fields) THEN e.parking_details ELSE t.parking_details END,
      reservation_details = CASE WHEN 'reservation_details' = ANY(e.admin_locked_fields) THEN e.reservation_details ELSE t.reservation_details END,
$remove$,
    '');
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: bulk update replacement failed'; END IF;
  EXECUTE changed;

  SELECT pg_get_functiondef('private.admin_validate_event_patch(jsonb)'::regprocedure) INTO definition;
  changed := replace(definition, $remove$    'parking_details',
    'reservation_details',
$remove$, '');
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: allowlist replacement failed'; END IF;
  EXECUTE changed;

  SELECT pg_get_functiondef('private.admin_update_event(uuid,jsonb,uuid[],boolean,text)'::regprocedure) INTO definition;
  changed := replace(definition, $remove$  next_parking_details text;
  next_reservation_details text;
$remove$, '');
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: admin declarations replacement failed'; END IF;
  definition := changed;
  changed := replace(definition,
    $remove$  next_parking_details := CASE
    WHEN patch ? 'parking_details' AND jsonb_typeof(patch->'parking_details') = 'null' THEN NULL
    WHEN patch ? 'parking_details' THEN NULLIF(btrim(patch->>'parking_details'), '')
    ELSE before_row.parking_details
  END;
  next_reservation_details := CASE
    WHEN patch ? 'reservation_details' AND jsonb_typeof(patch->'reservation_details') = 'null' THEN NULL
    WHEN patch ? 'reservation_details' THEN NULLIF(btrim(patch->>'reservation_details'), '')
    ELSE before_row.reservation_details
  END;
$remove$, '');
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: admin values replacement failed'; END IF;
  definition := changed;
  changed := replace(definition,
    $remove$         parking_details = next_parking_details,
         reservation_details = next_reservation_details,
$remove$,
    '');
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: admin update replacement failed'; END IF;
  EXECUTE changed;

  SELECT pg_get_functiondef(
    'public.events_enriched(uuid,text,uuid,uuid[],timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure
  ) INTO definition;
  changed := replace(definition,
    'admission_cost_evidence text, parking_details text, reservation_details text, source_url text',
    'admission_cost_evidence text, source_url text');
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: events_enriched return replacement failed'; END IF;
  definition := changed;
  changed := regexp_replace(
    definition,
    E'e\\.admission_cost_evidence,\\s+e\\.parking_details,\\s+e\\.reservation_details,\\s+e\\.source_url,',
    'e.admission_cost_evidence, e.source_url,'
  );
  IF changed = definition THEN RAISE EXCEPTION 'family details rollback: events_enriched projection replacement failed'; END IF;
  DROP FUNCTION public.events_enriched(
    uuid, text, uuid, uuid[], timestamptz, timestamptz, timestamptz, uuid, integer
  );
  EXECUTE changed;
END;
$migration$;
REVOKE ALL ON FUNCTION public.events_enriched(
  uuid, text, uuid, uuid[], timestamptz, timestamptz, timestamptz, uuid, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.events_enriched(
  uuid, text, uuid, uuid[], timestamptz, timestamptz, timestamptz, uuid, integer
) TO anon, authenticated, service_role;

ALTER TABLE public.events
  DROP COLUMN IF EXISTS reservation_details,
  DROP COLUMN IF EXISTS parking_details;
