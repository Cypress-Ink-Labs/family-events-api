/*
  Behavioral family-needs coverage at the PostgreSQL/API data seam.
  Run only against a disposable PostgreSQL database.
*/

\set ON_ERROR_STOP on
\set VERBOSITY terse

BEGIN;
SET LOCAL search_path = pg_catalog, public, private;

INSERT INTO public.events (
  id, title, description, venue_name, address, start_datetime, end_datetime,
  status, parking_details, reservation_details
) VALUES
  ('19000000-0000-4000-8000-000000000001', 'Family needs published fixture',
   'wheelchair accessible stroller friendly sensory friendly indoor outdoor',
   'Original Hall', '1 Main St', '2099-09-19T15:00:00Z', '2099-09-19T17:00:00Z',
   'published', 'Use the east lot.', 'Reserve by Friday.'),
  ('19000000-0000-4000-8000-000000000002', 'Family needs draft fixture',
   'Indoor wheelchair accessible', 'Draft Hall', '2 Main St',
   '2099-09-20T15:00:00Z', '2099-09-20T17:00:00Z', 'draft', NULL, NULL),
  ('19000000-0000-4000-8000-000000000003', 'Family needs parity confirmed',
   NULL, 'Parity Hall', '3 Main St', '2099-09-21T15:00:00Z',
   '2099-09-21T17:00:00Z', 'published', NULL, NULL),
  ('19000000-0000-4000-8000-000000000004', 'Family needs parity unknown',
   NULL, 'Parity Hall', '4 Main St', '2099-09-22T15:00:00Z',
   '2099-09-22T17:00:00Z', 'published', NULL, NULL);

INSERT INTO public.event_family_need_evidence (
  id, event_id, claim, value, provenance_type, source_url, statement, observed_at,
  applicable_venue_name, applicable_address, applicable_start_datetime, applicable_end_datetime
) VALUES
  ('19100000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001',
   'indoor', 'supported', 'source_statement', 'https://needs.example/one',
   'This event is indoors.', '2099-01-01T00:00:00Z',
   'Original Hall', '1 Main St', '2099-09-19T15:00:00Z', '2099-09-19T17:00:00Z'),
  ('19100000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-000000000001',
   'outdoor', 'supported', 'source_statement', 'https://needs.example/one',
   'Activities are outdoors.', '2099-01-01T00:00:00Z',
   'Original Hall', '1 Main St', '2099-09-19T15:00:00Z', '2099-09-19T17:00:00Z'),
  ('19100000-0000-4000-8000-000000000003', '19000000-0000-4000-8000-000000000001',
   'outdoor', 'unsupported', 'human', NULL,
   'Operator verified that activities moved inside.', '2099-01-02T00:00:00Z',
   'Original Hall', '1 Main St', '2099-09-19T15:00:00Z', '2099-09-19T17:00:00Z'),
  ('19100000-0000-4000-8000-000000000004', '19000000-0000-4000-8000-000000000001',
   'wheelchair_accessible', 'unsupported', 'human', NULL,
   'Operator could not verify an accessible entrance.', '2099-01-03T00:00:00Z',
   'Original Hall', '1 Main St', '2099-09-19T15:00:00Z', '2099-09-19T17:00:00Z'),
  ('19100000-0000-4000-8000-000000000005', '19000000-0000-4000-8000-000000000001',
   'wheelchair_accessible', 'supported', 'organizer', NULL,
   'Organizer confirms the east entrance is accessible.', '2099-01-01T00:00:00Z',
   'Original Hall', '1 Main St', '2099-09-19T15:00:00Z', '2099-09-19T17:00:00Z'),
  ('19100000-0000-4000-8000-000000000006', '19000000-0000-4000-8000-000000000003',
   'indoor', 'supported', 'source_statement', 'https://needs.example/parity',
   'Held indoors.', '2099-01-01T00:00:00Z',
   'Parity Hall', '3 Main St', '2099-09-21T15:00:00Z', '2099-09-21T17:00:00Z');

DO $$
DECLARE needs jsonb;
BEGIN
  IF (SELECT count(*) FROM public.event_family_needs
      WHERE event_id = '19000000-0000-4000-8000-000000000001') <> 5 THEN
    RAISE EXCEPTION 'FAMILY_NEEDS_VIEW_MUST_RETURN_FIVE_CLAIMS';
  END IF;

  SELECT jsonb_object_agg(claim, state) INTO needs
  FROM public.event_family_needs
  WHERE event_id = '19000000-0000-4000-8000-000000000001';
  IF needs <> '{
    "indoor": "confirmed",
    "outdoor": "contradicted",
    "wheelchair_accessible": "contradicted",
    "sensory_friendly": "unknown",
    "stroller_friendly": "unknown"
  }'::jsonb THEN
    RAISE EXCEPTION 'FAMILY_NEEDS_STATES_WRONG: %', needs;
  END IF;

  IF (SELECT value FROM public.event_family_needs
      WHERE event_id = '19000000-0000-4000-8000-000000000001'
        AND claim = 'wheelchair_accessible') <> 'supported'
     OR NOT (SELECT has_conflict FROM public.event_family_needs
             WHERE event_id = '19000000-0000-4000-8000-000000000001'
               AND claim = 'wheelchair_accessible') THEN
    RAISE EXCEPTION 'ORGANIZER_PRECEDENCE_OR_CONFLICT_HISTORY_LOST';
  END IF;

  -- Consumer filters must conservatively exclude conflicts. Explore and Map
  -- consume the same eligible set before applying their independent limits.
  IF EXISTS (
    SELECT 1 FROM public.event_family_needs
    WHERE event_id = '19000000-0000-4000-8000-000000000001'
      AND claim IN ('outdoor', 'wheelchair_accessible') AND state = 'confirmed'
  ) THEN
    RAISE EXCEPTION 'CONFLICT_WAS_INCLUDED_AS_CONFIRMED';
  END IF;
  IF ARRAY(
      SELECT event_id FROM public.event_family_needs
      WHERE claim = 'indoor' AND state = 'confirmed'
        AND event_id::text LIKE '19000000-0000-4000-8000-00000000000%'
      ORDER BY event_id
    ) <> ARRAY[
      '19000000-0000-4000-8000-000000000001'::uuid,
      '19000000-0000-4000-8000-000000000003'::uuid
    ] THEN
    RAISE EXCEPTION 'EXPLORE_MAP_PRELIMIT_ELIGIBILITY_DRIFT';
  END IF;

  IF EXISTS (SELECT 1 FROM public.event_family_needs
             WHERE event_id = '19000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'UNPUBLISHED_EVENT_EXPOSED';
  END IF;

  -- Description/title keywords alone are not attributable evidence.
  IF EXISTS (SELECT 1 FROM public.event_family_need_evidence
             WHERE event_id = '19000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'KEYWORDS_OR_AI_INFERRED_SOURCE_EVIDENCE';
  END IF;

  IF (SELECT parking_details FROM public.events
      WHERE id = '19000000-0000-4000-8000-000000000001') <> 'Use the east lot.'
     OR (SELECT reservation_details FROM public.events
         WHERE id = '19000000-0000-4000-8000-000000000001') <> 'Reserve by Friday.'
  THEN
    RAISE EXCEPTION 'PRACTICAL_DETAILS_NOT_STORED';
  END IF;
END $$;

-- Title-only edits do not invalidate evidence.
UPDATE public.events SET title = 'Family needs renamed fixture'
WHERE id = '19000000-0000-4000-8000-000000000001';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.event_family_need_evidence
             WHERE event_id = '19000000-0000-4000-8000-000000000001'
               AND invalidated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'TITLE_CHANGE_INVALIDATED_EVIDENCE';
  END IF;
END $$;

-- A material venue/time edit invalidates applicable evidence, preserving IDs
-- and contradictory history for the operator evidence endpoint.
UPDATE public.events SET venue_name = 'Replacement Hall'
WHERE id = '19000000-0000-4000-8000-000000000001';
DO $$
BEGIN
  IF (SELECT count(*) FROM public.event_family_need_evidence
      WHERE event_id = '19000000-0000-4000-8000-000000000001'
        AND invalidated_at IS NOT NULL
        AND invalidation_reason IS NOT NULL) <> 5 THEN
    RAISE EXCEPTION 'MATERIAL_CHANGE_DID_NOT_INVALIDATE_APPLICABLE_EVIDENCE';
  END IF;
  IF (SELECT count(DISTINCT id) FROM public.event_family_need_evidence
      WHERE event_id = '19000000-0000-4000-8000-000000000001') <> 5 THEN
    RAISE EXCEPTION 'EVIDENCE_HISTORY_IDS_NOT_PRESERVED';
  END IF;
  IF (SELECT count(*) FROM public.event_family_need_evidence
      WHERE event_id = '19000000-0000-4000-8000-000000000001'
        AND claim IN ('outdoor', 'wheelchair_accessible')) <> 4 THEN
    RAISE EXCEPTION 'CONFLICT_HISTORY_NOT_PRESERVED';
  END IF;
END $$;

-- Database authorization is part of the operator API boundary.
DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.event_family_need_evidence (
      event_id, claim, value, provenance_type, statement, observed_at
    ) VALUES (
      '19000000-0000-4000-8000-000000000003', 'outdoor', 'supported',
      'human', 'Unauthorized write', now()
    );
    RESET ROLE;
    RAISE EXCEPTION 'AUTHENTICATED_EVIDENCE_WRITE_ACCEPTED';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;
END $$;

INSERT INTO public.event_sources (id, name, url, source_type, auto_approve)
VALUES ('19200000-0000-4000-8000-000000000001', 'Needs fixture source',
        'https://needs.example/events', 'rss', true);
UPDATE public.events
SET source_id = '19200000-0000-4000-8000-000000000001',
    source_url = 'https://needs.example/parity-unknown'
WHERE id = '19000000-0000-4000-8000-000000000004';

SELECT private.import_family_need_statements(
  '19200000-0000-4000-8000-000000000001',
  jsonb_build_array(
    jsonb_build_object(
      'source_url', 'https://needs.example/parity-unknown',
      'description', 'wheelchair accessible',
      'ai_family_needs', jsonb_build_array('wheelchair_accessible'),
      'family_need_statements', jsonb_build_array(
        jsonb_build_object(
          'claim', 'stroller_friendly', 'value', 'supported',
          'statement', 'Strollers are welcome.',
          'source_url', 'https://needs.example/parity-unknown',
          'observed_at', '2099-01-04T00:00:00Z'
        )
      )
    )
  )
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.event_family_need_evidence
      WHERE event_id = '19000000-0000-4000-8000-000000000004') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.event_family_need_evidence
       WHERE event_id = '19000000-0000-4000-8000-000000000004'
         AND claim = 'stroller_friendly' AND provenance_type = 'source_statement'
         AND statement = 'Strollers are welcome.'
     )
  THEN
    RAISE EXCEPTION 'INGESTION_DID_NOT_REQUIRE_EXPLICIT_ATTRIBUTABLE_PHRASE';
  END IF;
END $$;

-- Detail and favorites projections both derive the same five-state object.
INSERT INTO auth.users (id, email, aud, role, instance_id)
VALUES ('19300000-0000-4000-8000-000000000001', 'needs-user@test.local',
        'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
UPDATE public.user_profiles
SET display_name = 'Family needs operator', role = 'admin'
WHERE id = '19300000-0000-4000-8000-000000000001';
INSERT INTO public.user_access (user_id, is_enabled, enabled_at)
VALUES ('19300000-0000-4000-8000-000000000001', true, now())
ON CONFLICT (user_id) DO UPDATE
SET is_enabled = true, enabled_at = EXCLUDED.enabled_at, access_expires_at = NULL;

SELECT set_config(
  'request.jwt.claim.sub',
  '19300000-0000-4000-8000-000000000001',
  true
);
SELECT public.admin_update_event(
  '19000000-0000-4000-8000-000000000003',
  jsonb_build_object(
    'parking_details', 'Garage entrance is on Oak Street.',
    'reservation_details', 'Reserve a sensory kit online.'
  ),
  '{}'::uuid[],
  true,
  'Verify practical family details'
);

INSERT INTO public.favorites (user_id, event_id)
VALUES ('19300000-0000-4000-8000-000000000001',
        '19000000-0000-4000-8000-000000000003');

DO $$
DECLARE detail_needs jsonb; favorite_needs jsonb;
BEGIN
  IF (SELECT parking_details FROM public.events
      WHERE id = '19000000-0000-4000-8000-000000000003')
       <> 'Garage entrance is on Oak Street.'
     OR (SELECT reservation_details FROM public.events
         WHERE id = '19000000-0000-4000-8000-000000000003')
       <> 'Reserve a sensory kit online.'
  THEN
    RAISE EXCEPTION 'ADMIN_PRACTICAL_DETAILS_UPDATE_FAILED';
  END IF;

  SELECT jsonb_object_agg(claim, state) INTO detail_needs
  FROM public.event_family_needs
  WHERE event_id = '19000000-0000-4000-8000-000000000003';
  SELECT jsonb_object_agg(n.claim, n.state) INTO favorite_needs
  FROM public.favorites f
  JOIN public.event_family_needs n ON n.event_id = f.event_id
  WHERE f.user_id = '19300000-0000-4000-8000-000000000001'
    AND f.event_id = '19000000-0000-4000-8000-000000000003';
  IF (SELECT count(*) FROM jsonb_object_keys(detail_needs)) <> 5
     OR favorite_needs <> detail_needs THEN
    RAISE EXCEPTION 'DETAIL_FAVORITES_FAMILY_NEEDS_PARITY_FAILED';
  END IF;
END $$;

ROLLBACK;
