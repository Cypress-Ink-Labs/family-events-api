/*
  Evidence-backed admission-cost integration coverage.
  Run only against a disposable PostgreSQL database.
*/

\set ON_ERROR_STOP on
\set VERBOSITY terse

BEGIN;

INSERT INTO public.events (
  title, start_datetime, status, is_free, price,
  admission_cost_state, admission_amount, admission_cost_evidence
)
VALUES
  ('Admission free fixture', '2099-06-15T15:00:00Z', 'published', true, NULL,
   'free', NULL, 'Free admission'),
  ('Admission paid amount fixture', '2099-06-15T16:00:00Z', 'published', false, 12,
   'paid', 12, 'Tickets $12'),
  ('Admission paid unknown amount fixture', '2099-06-15T17:00:00Z', 'published', false, NULL,
   'paid', NULL, 'Admission fee applies'),
  ('Admission unknown fixture', '2099-06-15T18:00:00Z', 'published', false, NULL,
   'unknown', NULL, NULL);

-- Historical legacy values remain truthful unknowns after the conservative
-- default/backfill, including both old boolean values and an old amount.
INSERT INTO public.events (title, start_datetime, status, is_free, price)
VALUES
  ('Admission legacy false fixture', '2099-06-15T19:00:00Z', 'published', false, 7),
  ('Admission legacy true fixture', '2099-06-15T20:00:00Z', 'published', true, NULL);

INSERT INTO public.event_sources (id, name, url, source_type, auto_approve)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Admission fixture source',
  'https://admission.example/events',
  'rss',
  true
);
INSERT INTO public.source_runs (id, source_id)
VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);

SELECT public.bulk_import_scrape_events(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  jsonb_build_array(
    jsonb_build_object(
      'title', 'Admission imported paid fixture',
      'description', 'Admission fee applies',
      'start_datetime', '2099-06-16T15:00:00Z',
      'timezone', 'America/Chicago',
      'source_url', 'https://admission.example/paid',
      'source_name', 'Admission fixture source',
      'source_details_fetched_at', '2026-09-14T12:00:00Z',
      'admission_cost_state', 'paid',
      'admission_amount', NULL,
      'admission_cost_evidence', 'Admission fee applies'
    ),
    -- A pre-cost ingestion caller remains valid and creates truthful unknown.
    jsonb_build_object(
      'title', 'Admission legacy import fixture',
      'description', 'No admission details',
      'start_datetime', '2099-06-16T16:00:00Z',
      'timezone', 'America/Chicago',
      'source_url', 'https://admission.example/legacy',
      'source_name', 'Admission fixture source',
      'source_details_fetched_at', '2026-09-14T12:00:00Z',
      'is_free', false
    )
  )
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.events
    WHERE title LIKE 'Admission legacy % fixture'
      AND admission_cost_state <> 'unknown'
  ) THEN
    RAISE EXCEPTION 'ADMISSION_LEGACY_BACKFILL_INFERRED_EVIDENCE';
  END IF;

  IF (SELECT admission_amount
      FROM public.events
      WHERE title = 'Admission paid unknown amount fixture') IS NOT NULL THEN
    RAISE EXCEPTION 'ADMISSION_PAID_AMOUNT_NOT_INDEPENDENTLY_NULLABLE';
  END IF;

  IF (SELECT count(*)
      FROM public.events_enriched(p_event_ids => ARRAY[
        (SELECT id FROM public.events WHERE title = 'Admission free fixture'),
        (SELECT id FROM public.events WHERE title = 'Admission paid unknown amount fixture')
      ]::uuid[])) <> 2 THEN
    RAISE EXCEPTION 'ADMISSION_ENRICHED_CONTRACT_MISSING_ROWS';
  END IF;

  IF (SELECT admission_cost_state
      FROM public.events
      WHERE title = 'Admission imported paid fixture') <> 'paid'
     OR (SELECT admission_cost_evidence
         FROM public.events
         WHERE title = 'Admission imported paid fixture') <> 'Admission fee applies'
  THEN
    RAISE EXCEPTION 'ADMISSION_INGESTION_EVIDENCE_NOT_PRESERVED';
  END IF;

  IF (SELECT admission_cost_state
      FROM public.events
      WHERE title = 'Admission legacy import fixture') <> 'unknown'
  THEN
    RAISE EXCEPTION 'ADMISSION_LEGACY_INGESTION_INFERRED_PAID';
  END IF;

  BEGIN
    INSERT INTO public.events (
      title, start_datetime, admission_cost_state, admission_cost_evidence
    ) VALUES ('Invalid evidence fixture', '2099-06-16T15:00:00Z', 'paid', NULL);
    RAISE EXCEPTION 'ADMISSION_PAID_WITHOUT_EVIDENCE_ACCEPTED';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END $$;

INSERT INTO auth.users (id, email, aud, role, instance_id)
VALUES (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'admission-admin@test.local',
  'authenticated',
  'authenticated',
  '00000000-0000-0000-0000-000000000000'
);
INSERT INTO public.user_profiles (id, email, display_name, role)
VALUES (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'admission-admin@test.local',
  'Admission admin',
  'admin'
)
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  display_name = EXCLUDED.display_name,
  role = EXCLUDED.role;
INSERT INTO public.user_access (user_id, is_enabled, enabled_at)
VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', true, now())
ON CONFLICT (user_id) DO UPDATE SET
  is_enabled = EXCLUDED.is_enabled,
  enabled_at = EXCLUDED.enabled_at,
  access_expires_at = NULL;

SELECT set_config(
  'request.jwt.claim.sub',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  true
);
SELECT public.admin_update_event(
  (SELECT id FROM public.events WHERE title = 'Admission unknown fixture'),
  jsonb_build_object(
    'admission_cost_state', 'paid',
    'admission_amount', NULL,
    'admission_cost_evidence', 'Operator recorded source admission fee'
  ),
  '{}'::uuid[],
  true,
  'Recorded source cost evidence'
);

DO $$
BEGIN
  IF (SELECT admission_cost_state
      FROM public.events
      WHERE title = 'Admission unknown fixture') <> 'paid'
     OR NOT (
       SELECT admin_locked_fields @> ARRAY[
         'admission_cost_state',
         'admission_amount',
         'admission_cost_evidence'
       ]
       FROM public.events
       WHERE title = 'Admission unknown fixture'
     )
  THEN
    RAISE EXCEPTION 'ADMISSION_AUTHORIZED_EDITOR_DID_NOT_PRESERVE_EVIDENCE';
  END IF;
END $$;

ROLLBACK;
