-- Evidence-backed family-needs claims. Historical tags and is_outdoor values are
-- deliberately not backfilled: neither records attributable evidence.
ALTER TABLE public.events
  ADD COLUMN parking_details text NULL,
  ADD COLUMN reservation_details text NULL;

DO $migration$
DECLARE definition text; changed text;
BEGIN
  SELECT pg_get_functiondef('private.bulk_import_scrape_events(uuid,uuid,jsonb)'::regprocedure)
    INTO definition;
  changed := replace(
    definition,
    $old$      NULLIF(btrim(elem->>'admission_cost_evidence'), '') AS admission_cost_evidence,
$old$,
    $new$      NULLIF(btrim(elem->>'admission_cost_evidence'), '') AS admission_cost_evidence,
      NULLIF(btrim(elem->>'parking_details'), '') AS parking_details,
      NULLIF(btrim(elem->>'reservation_details'), '') AS reservation_details,
$new$
  );
  IF changed = definition THEN RAISE EXCEPTION 'family details: bulk parsing replacement failed'; END IF;
  definition := changed;
  changed := replace(definition,
    'admission_cost_evidence, is_outdoor,',
    'admission_cost_evidence, parking_details, reservation_details, is_outdoor,');
  IF changed = definition THEN RAISE EXCEPTION 'family details: bulk columns replacement failed'; END IF;
  definition := changed;
  changed := replace(definition,
    's.admission_cost_evidence, s.is_outdoor,',
    's.admission_cost_evidence, s.parking_details, s.reservation_details, s.is_outdoor,');
  IF changed = definition THEN RAISE EXCEPTION 'family details: bulk values replacement failed'; END IF;
  definition := changed;
  changed := replace(
    definition,
    $old$      admission_cost_evidence = CASE WHEN 'admission_cost_evidence' = ANY(e.admin_locked_fields) THEN e.admission_cost_evidence ELSE t.admission_cost_evidence END,
$old$,
    $new$      admission_cost_evidence = CASE WHEN 'admission_cost_evidence' = ANY(e.admin_locked_fields) THEN e.admission_cost_evidence ELSE t.admission_cost_evidence END,
      parking_details = CASE WHEN 'parking_details' = ANY(e.admin_locked_fields) THEN e.parking_details ELSE t.parking_details END,
      reservation_details = CASE WHEN 'reservation_details' = ANY(e.admin_locked_fields) THEN e.reservation_details ELSE t.reservation_details END,
$new$
  );
  IF changed = definition THEN RAISE EXCEPTION 'family details: bulk update replacement failed'; END IF;
  EXECUTE changed;
END;
$migration$;

DO $migration$
DECLARE definition text; changed text;
BEGIN
  SELECT pg_get_functiondef(
    'public.events_enriched(uuid,text,uuid,uuid[],timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure
  ) INTO definition;
  changed := replace(definition,
    'admission_cost_evidence text, source_url text',
    'admission_cost_evidence text, parking_details text, reservation_details text, source_url text');
  IF changed = definition THEN RAISE EXCEPTION 'family details: events_enriched row replacement failed'; END IF;
  definition := changed;
  changed := regexp_replace(
    definition,
    E'e\\.admission_cost_evidence,\\s+e\\.source_url,',
    'e.admission_cost_evidence, e.parking_details, e.reservation_details, e.source_url,'
  );
  IF changed = definition THEN RAISE EXCEPTION 'family details: events_enriched projection replacement failed'; END IF;
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

DO $migration$
DECLARE definition text; changed text;
BEGIN
  SELECT pg_get_functiondef('private.admin_validate_event_patch(jsonb)'::regprocedure)
    INTO definition;
  changed := replace(
    definition,
    $old$    'admission_cost_evidence',
$old$,
    $new$    'admission_cost_evidence',
    'parking_details',
    'reservation_details',
$new$
  );
  IF changed = definition THEN RAISE EXCEPTION 'family details: admin allowlist replacement failed'; END IF;
  EXECUTE changed;

  SELECT pg_get_functiondef(
    'private.admin_update_event(uuid,jsonb,uuid[],boolean,text)'::regprocedure
  ) INTO definition;
  changed := replace(
    definition,
    $old$  next_admission_cost_evidence text;
$old$,
    $new$  next_admission_cost_evidence text;
  next_parking_details text;
  next_reservation_details text;
$new$
  );
  IF changed = definition THEN RAISE EXCEPTION 'family details: admin variables replacement failed'; END IF;
  definition := changed;
  changed := replace(
    definition,
    $old$  next_admission_cost_evidence := CASE
    WHEN patch ? 'admission_cost_evidence'
         AND jsonb_typeof(patch->'admission_cost_evidence') = 'null' THEN NULL
    WHEN patch ? 'admission_cost_evidence'
      THEN NULLIF(btrim(patch->>'admission_cost_evidence'), '')
    ELSE before_row.admission_cost_evidence
  END;
$old$,
    $new$  next_admission_cost_evidence := CASE
    WHEN patch ? 'admission_cost_evidence'
         AND jsonb_typeof(patch->'admission_cost_evidence') = 'null' THEN NULL
    WHEN patch ? 'admission_cost_evidence'
      THEN NULLIF(btrim(patch->>'admission_cost_evidence'), '')
    ELSE before_row.admission_cost_evidence
  END;
  next_parking_details := CASE
    WHEN patch ? 'parking_details' AND jsonb_typeof(patch->'parking_details') = 'null' THEN NULL
    WHEN patch ? 'parking_details' THEN NULLIF(btrim(patch->>'parking_details'), '')
    ELSE before_row.parking_details
  END;
  next_reservation_details := CASE
    WHEN patch ? 'reservation_details' AND jsonb_typeof(patch->'reservation_details') = 'null' THEN NULL
    WHEN patch ? 'reservation_details' THEN NULLIF(btrim(patch->>'reservation_details'), '')
    ELSE before_row.reservation_details
  END;
$new$
  );
  IF changed = definition THEN RAISE EXCEPTION 'family details: admin merge replacement failed'; END IF;
  definition := changed;
  changed := replace(
    definition,
    $old$         admission_cost_evidence = next_admission_cost_evidence,
$old$,
    $new$         admission_cost_evidence = next_admission_cost_evidence,
         parking_details = next_parking_details,
         reservation_details = next_reservation_details,
$new$
  );
  IF changed = definition THEN RAISE EXCEPTION 'family details: admin update replacement failed'; END IF;
  EXECUTE changed;
END;
$migration$;

CREATE TYPE public.family_need_claim AS ENUM (
  'indoor',
  'outdoor',
  'wheelchair_accessible',
  'sensory_friendly',
  'stroller_friendly'
);
CREATE TYPE public.family_need_value AS ENUM (
  'supported',
  'unsupported'
);
CREATE TYPE public.family_need_provenance AS ENUM (
  'source_statement',
  'human',
  'organizer'
);

CREATE TABLE public.event_family_need_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  claim public.family_need_claim NOT NULL,
  value public.family_need_value NOT NULL,
  provenance_type public.family_need_provenance NOT NULL,
  source_url text NULL,
  statement text NOT NULL CHECK (NULLIF(btrim(statement), '') IS NOT NULL),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  applicable_venue_name text NULL,
  applicable_address text NULL,
  applicable_start_datetime timestamptz NULL,
  applicable_end_datetime timestamptz NULL,
  invalidated_at timestamptz NULL,
  invalidation_reason text NULL,
  CHECK (
    value IN ('supported', 'unsupported')
  ),
  CHECK (
    provenance_type <> 'source_statement'
    OR NULLIF(btrim(source_url), '') IS NOT NULL
  ),
  CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR
    (invalidated_at IS NOT NULL AND NULLIF(btrim(invalidation_reason), '') IS NOT NULL)
  )
);

CREATE INDEX event_family_need_evidence_current_idx
  ON public.event_family_need_evidence (
    event_id,
    claim,
    provenance_type,
    observed_at DESC,
    recorded_at DESC,
    id DESC
  )
  WHERE invalidated_at IS NULL;

COMMENT ON TABLE public.event_family_need_evidence IS
  'Append-only attributable family-needs evidence. Conflicts are preserved; AI output is not a provenance type.';

CREATE VIEW public.event_family_needs
WITH (security_barrier = true)
AS
WITH ranked AS (
  SELECT e.*,
    bool_or(value = 'supported') OVER (PARTITION BY event_id, claim) AS has_positive,
    bool_or(value = 'unsupported') OVER (PARTITION BY event_id, claim) AS has_negative,
    row_number() OVER (
      PARTITION BY event_id, claim
      ORDER BY
        CASE provenance_type WHEN 'organizer' THEN 3 WHEN 'human' THEN 2 ELSE 1 END DESC,
        observed_at DESC, recorded_at DESC, id DESC
    ) AS precedence
  FROM public.event_family_need_evidence e
  WHERE invalidated_at IS NULL
),
current_evidence AS (
SELECT event_id, claim,
  CASE
    WHEN has_positive AND has_negative THEN 'contradicted'
    WHEN value = 'supported' THEN 'confirmed'
    ELSE 'contradicted'
  END AS state,
  value, (has_positive AND has_negative) AS has_conflict
FROM ranked
WHERE precedence = 1
)
SELECT e.id AS event_id, claim.claim,
  COALESCE(current_evidence.state, 'unknown') AS state,
  current_evidence.value,
  COALESCE(current_evidence.has_conflict, false) AS has_conflict
FROM public.events e
CROSS JOIN unnest(enum_range(NULL::public.family_need_claim)) AS claim(claim)
LEFT JOIN current_evidence
  ON current_evidence.event_id = e.id AND current_evidence.claim = claim.claim
WHERE e.status = 'published'::public.event_status;

CREATE OR REPLACE FUNCTION private.invalidate_material_family_need_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (OLD.venue_name, OLD.address, OLD.start_datetime, OLD.end_datetime)
     IS DISTINCT FROM
     (NEW.venue_name, NEW.address, NEW.start_datetime, NEW.end_datetime) THEN
    UPDATE public.event_family_need_evidence
       SET invalidated_at = clock_timestamp(),
           invalidation_reason = 'material venue or occurrence details changed'
     WHERE event_id = NEW.id AND invalidated_at IS NULL
       AND (
         applicable_venue_name IS NOT NULL
         OR applicable_address IS NOT NULL
         OR applicable_start_datetime IS NOT NULL
         OR applicable_end_datetime IS NOT NULL
       );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invalidate_material_family_need_evidence
AFTER UPDATE OF venue_name, address, start_datetime, end_datetime ON public.events
FOR EACH ROW EXECUTE FUNCTION private.invalidate_material_family_need_evidence();

REVOKE ALL ON FUNCTION private.invalidate_material_family_need_evidence() FROM PUBLIC;
REVOKE ALL ON public.event_family_need_evidence
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.event_family_need_evidence TO service_role;
GRANT SELECT ON public.event_family_needs TO anon, authenticated, service_role;

CREATE FUNCTION private.import_family_need_statements(p_source_id uuid, p_events jsonb)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH statements AS (
    SELECT item, statement
    FROM jsonb_array_elements(p_events) item
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(item->'family_need_statements', '[]')) statement
    WHERE NULLIF(btrim(statement->>'statement'), '') IS NOT NULL
      AND NULLIF(btrim(statement->>'source_url'), '') IS NOT NULL
      AND statement->>'claim' IN (
        'indoor', 'outdoor', 'wheelchair_accessible', 'sensory_friendly', 'stroller_friendly'
      )
      AND statement->>'value' IN ('supported', 'unsupported')
  ),
  inserted AS (
    INSERT INTO public.event_family_need_evidence (
      event_id, claim, value, provenance_type, source_url, statement, observed_at,
      applicable_venue_name, applicable_address, applicable_start_datetime, applicable_end_datetime
    )
    SELECT e.id, (s.statement->>'claim')::public.family_need_claim,
      (s.statement->>'value')::public.family_need_value, 'source_statement',
      s.statement->>'source_url', s.statement->>'statement',
      COALESCE(NULLIF(s.statement->>'observed_at', '')::timestamptz, clock_timestamp()),
      e.venue_name, e.address, e.start_datetime, e.end_datetime
    FROM statements s
    JOIN public.events e
      ON e.source_id = p_source_id AND e.source_url = s.item->>'source_url'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.event_family_need_evidence old
      WHERE old.event_id = e.id
        AND old.claim::text = s.statement->>'claim'
        AND old.value::text = s.statement->>'value'
        AND old.provenance_type = 'source_statement'
        AND old.source_url = s.statement->>'source_url'
        AND old.statement = s.statement->>'statement'
        AND old.invalidated_at IS NULL
    )
    RETURNING 1
  )
  SELECT count(*)::integer FROM inserted;
$$;
REVOKE ALL ON FUNCTION private.import_family_need_statements(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.import_family_need_statements(uuid, jsonb) TO service_role;
