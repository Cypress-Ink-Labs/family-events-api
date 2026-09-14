-- Add evidence-backed admission classification without deriving truth from the
-- legacy is_free/price pair. Historical rows deliberately remain unknown.

CREATE TYPE public.admission_cost_state AS ENUM ('free', 'paid', 'unknown');

ALTER TABLE public.events
  ADD COLUMN admission_cost_state public.admission_cost_state NOT NULL DEFAULT 'unknown',
  ADD COLUMN admission_amount numeric NULL,
  ADD COLUMN admission_cost_evidence text NULL,
  ADD CONSTRAINT events_admission_cost_evidence_check CHECK (
    (
      admission_cost_state = 'unknown'
      AND admission_amount IS NULL
      AND admission_cost_evidence IS NULL
    )
    OR (
      admission_cost_state = 'free'
      AND admission_amount IS NULL
      AND NULLIF(btrim(admission_cost_evidence), '') IS NOT NULL
    )
    OR (
      admission_cost_state = 'paid'
      AND (admission_amount IS NULL OR admission_amount >= 0)
      AND NULLIF(btrim(admission_cost_evidence), '') IS NOT NULL
    )
  );

COMMENT ON COLUMN public.events.admission_cost_state IS
  'Evidence-backed admission classification. Legacy is_free=false is not paid evidence.';
COMMENT ON COLUMN public.events.admission_amount IS
  'Known admission amount, when the source states one. NULL is valid for paid admission.';
COMMENT ON COLUMN public.events.admission_cost_evidence IS
  'Source excerpt or operator-recorded evidence supporting a free or paid classification.';

-- Extend the current import implementation in place so this migration composes
-- with listing freshness. Every replacement is strict to avoid silently
-- discarding later changes.
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
    $old$      NULLIF(elem->>'price', '')::numeric       AS price,
      COALESCE((elem->>'is_free')::boolean, false) AS is_free,
$old$,
    $new$      NULLIF(elem->>'price', '')::numeric       AS price,
      COALESCE((elem->>'is_free')::boolean, false) AS is_free,
      COALESCE(NULLIF(elem->>'admission_cost_state', ''), 'unknown')::public.admission_cost_state
                                                   AS admission_cost_state,
      NULLIF(elem->>'admission_amount', '')::numeric AS admission_amount,
      NULLIF(btrim(elem->>'admission_cost_evidence'), '') AS admission_cost_evidence,
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not extend bulk payload parsing';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    'price, is_free, is_outdoor,',
    'price, is_free, admission_cost_state, admission_amount, admission_cost_evidence, is_outdoor,'
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not extend bulk insert columns';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    's.price, s.is_free, s.is_outdoor,',
    's.price, s.is_free, s.admission_cost_state, s.admission_amount, s.admission_cost_evidence, s.is_outdoor,'
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not extend bulk insert values';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$      is_free        = CASE WHEN 'is_free'        = ANY(e.admin_locked_fields) THEN e.is_free        ELSE t.is_free        END,
$old$,
    $new$      is_free        = CASE WHEN 'is_free'        = ANY(e.admin_locked_fields) THEN e.is_free        ELSE t.is_free        END,
      admission_cost_state = CASE WHEN 'admission_cost_state' = ANY(e.admin_locked_fields) THEN e.admission_cost_state ELSE t.admission_cost_state END,
      admission_amount = CASE WHEN 'admission_amount' = ANY(e.admin_locked_fields) THEN e.admission_amount ELSE t.admission_amount END,
      admission_cost_evidence = CASE WHEN 'admission_cost_evidence' = ANY(e.admin_locked_fields) THEN e.admission_cost_evidence ELSE t.admission_cost_evidence END,
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not extend bulk update';
  END IF;

  EXECUTE changed;
END;
$migration$;

-- Preserve the existing RPC signature while extending only its row contract.
DO $migration$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef(
    'public.events_enriched(uuid,text,uuid,uuid[],timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure
  ) INTO definition;

  changed := replace(
    definition,
    'price numeric, is_free boolean, source_url text',
    'price numeric, is_free boolean, admission_cost_state public.admission_cost_state, admission_amount numeric, admission_cost_evidence text, source_url text'
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not extend events_enriched row type';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    'e.age_min, e.age_max, e.price, e.is_free,',
    'e.age_min, e.age_max, e.price, e.is_free, e.admission_cost_state, e.admission_amount, e.admission_cost_evidence,'
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not extend events_enriched projection';
  END IF;

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

-- Authorized editor support. The RPC already owns authorization, locking and
-- audit behavior; these strict changes add the three admission fields to it.
DO $migration$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef(
    'private.admin_validate_event_patch(jsonb)'::regprocedure
  ) INTO definition;

  changed := replace(
    definition,
    $old$    'price',
    'is_free',
$old$,
    $new$    'price',
    'is_free',
    'admission_cost_state',
    'admission_amount',
    'admission_cost_evidence',
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not extend admin patch allowlist';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$  IF p_patch ? 'status'
$old$,
    $new$  IF p_patch ? 'admission_cost_state'
     AND (p_patch->>'admission_cost_state') NOT IN ('free', 'paid', 'unknown') THEN
    RAISE EXCEPTION 'ADMIN_EVENT_INVALID_ADMISSION_COST_STATE';
  END IF;

  IF p_patch ? 'status'
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not add admin state validation';
  END IF;

  EXECUTE changed;
END;
$migration$;

DO $migration$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef(
    'private.admin_update_event(uuid,jsonb,uuid[],boolean,text)'::regprocedure
  ) INTO definition;

  changed := replace(
    definition,
    $old$  next_price numeric;
$old$,
    $new$  next_price numeric;
  next_admission_cost_state public.admission_cost_state;
  next_admission_amount numeric;
  next_admission_cost_evidence text;
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not add admin variables';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$  next_price := CASE
    WHEN patch ? 'price' AND jsonb_typeof(patch->'price') = 'null' THEN NULL
    WHEN patch ? 'price' THEN (patch->>'price')::numeric
    ELSE before_row.price
  END;
$old$,
    $new$  next_price := CASE
    WHEN patch ? 'price' AND jsonb_typeof(patch->'price') = 'null' THEN NULL
    WHEN patch ? 'price' THEN (patch->>'price')::numeric
    ELSE before_row.price
  END;
  next_admission_cost_state := CASE
    WHEN patch ? 'admission_cost_state'
      THEN (patch->>'admission_cost_state')::public.admission_cost_state
    ELSE before_row.admission_cost_state
  END;
  next_admission_amount := CASE
    WHEN patch ? 'admission_amount' AND jsonb_typeof(patch->'admission_amount') = 'null' THEN NULL
    WHEN patch ? 'admission_amount' THEN (patch->>'admission_amount')::numeric
    ELSE before_row.admission_amount
  END;
  next_admission_cost_evidence := CASE
    WHEN patch ? 'admission_cost_evidence'
         AND jsonb_typeof(patch->'admission_cost_evidence') = 'null' THEN NULL
    WHEN patch ? 'admission_cost_evidence'
      THEN NULLIF(btrim(patch->>'admission_cost_evidence'), '')
    ELSE before_row.admission_cost_evidence
  END;
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not compute admin values';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$  IF next_price IS NOT NULL AND next_price < 0 THEN
    RAISE EXCEPTION 'ADMIN_EVENT_INVALID_PRICE';
  END IF;
$old$,
    $new$  IF next_price IS NOT NULL AND next_price < 0 THEN
    RAISE EXCEPTION 'ADMIN_EVENT_INVALID_PRICE';
  END IF;
  IF next_admission_amount IS NOT NULL AND next_admission_amount < 0 THEN
    RAISE EXCEPTION 'ADMIN_EVENT_INVALID_ADMISSION_AMOUNT';
  END IF;
  IF next_admission_cost_state = 'unknown'
     AND (next_admission_amount IS NOT NULL OR next_admission_cost_evidence IS NOT NULL) THEN
    RAISE EXCEPTION 'ADMIN_EVENT_UNKNOWN_ADMISSION_HAS_EVIDENCE';
  END IF;
  IF next_admission_cost_state = 'free'
     AND (next_admission_amount IS NOT NULL OR next_admission_cost_evidence IS NULL) THEN
    RAISE EXCEPTION 'ADMIN_EVENT_INVALID_FREE_ADMISSION';
  END IF;
  IF next_admission_cost_state = 'paid'
     AND next_admission_cost_evidence IS NULL THEN
    RAISE EXCEPTION 'ADMIN_EVENT_PAID_ADMISSION_EVIDENCE_REQUIRED';
  END IF;
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not add admin consistency checks';
  END IF;
  definition := changed;

  changed := replace(
    definition,
    $old$         is_free = CASE WHEN patch ? 'is_free' THEN (patch->>'is_free')::boolean ELSE is_free END,
$old$,
    $new$         is_free = CASE WHEN patch ? 'is_free' THEN (patch->>'is_free')::boolean ELSE is_free END,
         admission_cost_state = next_admission_cost_state,
         admission_amount = next_admission_amount,
         admission_cost_evidence = next_admission_cost_evidence,
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'admission migration could not extend admin update';
  END IF;

  EXECUTE changed;
END;
$migration$;
