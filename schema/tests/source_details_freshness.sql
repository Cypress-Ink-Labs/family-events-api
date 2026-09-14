/*
  Listing-level source freshness integration coverage.

  Exercises the public ingestion and read RPCs against real PostgreSQL. The
  fixture distinguishes a successful per-listing retrieval from source-run
  bookkeeping, omissions, malformed payloads, and manual/admin mutations.
*/

\set ON_ERROR_STOP on
\set VERBOSITY terse

BEGIN;

CREATE TEMP TABLE _freshness_fx (key text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO _freshness_fx (key, id) VALUES
  ('source_a', gen_random_uuid()),
  ('source_b', gen_random_uuid()),
  ('manual_source', gen_random_uuid()),
  ('run_a', gen_random_uuid()),
  ('run_b', gen_random_uuid()),
  ('admin', gen_random_uuid());

CREATE FUNCTION pg_temp.event_payload(
  p_title text,
  p_source_url text,
  p_source_name text,
  p_fetched_at text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'title', p_title,
    'description', 'Fixture description',
    'start_datetime', '2099-06-15T15:00:00+00',
    'end_datetime', NULL,
    'timezone', 'America/Chicago',
    'venue_name', 'Fixture venue',
    'address', '100 Main Street',
    'city_id', NULL,
    'source_url', p_source_url,
    'source_name', p_source_name,
    'source_details_fetched_at', p_fetched_at,
    'images', '[]'::jsonb,
    'price', NULL,
    'is_free', false,
    'is_outdoor', NULL,
    'latitude', NULL,
    'longitude', NULL
  );
$$;

DO $$
DECLARE
  column_type text;
  is_nullable text;
  column_default text;
BEGIN
  SELECT data_type, c.is_nullable, c.column_default
    INTO column_type, is_nullable, column_default
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name = 'events'
     AND c.column_name = 'source_details_fetched_at';

  IF column_type IS DISTINCT FROM 'timestamp with time zone'
     OR is_nullable IS DISTINCT FROM 'YES'
     OR column_default IS NOT NULL
  THEN
    RAISE EXCEPTION
      'SOURCE_FRESHNESS_COLUMN_FAIL: type=%, nullable=%, default=%',
      column_type, is_nullable, column_default;
  END IF;
END $$;

INSERT INTO public.event_sources (
  id, name, url, source_type, auto_approve
)
SELECT id, 'Freshness source A', 'https://source-a.example/events', 'rss', true
FROM _freshness_fx WHERE key = 'source_a'
UNION ALL
SELECT id, 'Freshness source B', 'https://source-b.example/events', 'rss', true
FROM _freshness_fx WHERE key = 'source_b'
UNION ALL
SELECT id, 'Manual source', 'https://manual.example/events', 'manual', false
FROM _freshness_fx WHERE key = 'manual_source';

INSERT INTO public.source_runs (id, source_id)
SELECT (SELECT id FROM _freshness_fx WHERE key = 'run_a'),
       (SELECT id FROM _freshness_fx WHERE key = 'source_a')
UNION ALL
SELECT (SELECT id FROM _freshness_fx WHERE key = 'run_b'),
       (SELECT id FROM _freshness_fx WHERE key = 'source_b');

-- Rows with no listing-level retrieval evidence remain unknown.
INSERT INTO public.events (
  title, start_datetime, status, source_id, source_name, source_url
)
VALUES
  (
    'Historical fixture',
    '2099-06-15T15:00:00+00',
    'published',
    (SELECT id FROM _freshness_fx WHERE key = 'source_a'),
    'Freshness source A',
    'https://source-a.example/historical'
  ),
  (
    'Manual fixture',
    '2099-06-15T15:00:00+00',
    'draft',
    (SELECT id FROM _freshness_fx WHERE key = 'manual_source'),
    'Manual source',
    NULL
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.events
     WHERE title IN ('Historical fixture', 'Manual fixture')
       AND source_details_fetched_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_UNKNOWN_ROWS_FAIL';
  END IF;
END $$;

-- Three successful listing retrievals at A: one will advance, one will model a
-- failed/invalid later retrieval, and one will be omitted from the later run.
SELECT public.bulk_import_scrape_events(
  (SELECT id FROM _freshness_fx WHERE key = 'run_a'),
  (SELECT id FROM _freshness_fx WHERE key = 'source_a'),
  jsonb_build_array(
    pg_temp.event_payload(
      'Unchanged success',
      'https://source-a.example/unchanged',
      'Freshness source A',
      '2026-06-01T12:00:00.123456+00'
    ),
    pg_temp.event_payload(
      'Later failed',
      'https://source-a.example/failed',
      'Freshness source A',
      '2026-06-01T12:00:00.123456+00'
    ),
    pg_temp.event_payload(
      'Later omitted',
      'https://source-a.example/omitted',
      'Freshness source A',
      '2026-06-01T12:00:00.123456+00'
    )
  )
);

DO $$
BEGIN
  IF (SELECT count(*)
        FROM public.events
       WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
         AND source_url LIKE 'https://source-a.example/%'
         AND source_url <> 'https://source-a.example/historical'
         AND source_details_fetched_at = '2026-06-01T12:00:00.123456+00'::timestamptz) <> 3
  THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_INSERT_FAIL';
  END IF;
END $$;

-- The otherwise unchanged listing advances on the same-source conflict path.
-- The failed and omitted listings are absent from this successful payload.
SELECT public.bulk_import_scrape_events(
  (SELECT id FROM _freshness_fx WHERE key = 'run_a'),
  (SELECT id FROM _freshness_fx WHERE key = 'source_a'),
  jsonb_build_array(
    pg_temp.event_payload(
      'Unchanged success',
      'https://source-a.example/unchanged',
      'Freshness source A',
      '2026-06-02T13:30:00.654321+00'
    )
  )
);

DO $$
BEGIN
  IF (SELECT source_details_fetched_at
        FROM public.events
       WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
         AND source_url = 'https://source-a.example/unchanged')
       IS DISTINCT FROM '2026-06-02T13:30:00.654321+00'::timestamptz
  THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_UNCHANGED_SUCCESS_FAIL';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.events
     WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
       AND source_url IN (
         'https://source-a.example/failed',
         'https://source-a.example/omitted'
       )
       AND source_details_fetched_at IS DISTINCT FROM
         '2026-06-01T12:00:00.123456+00'::timestamptz
  ) THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_PARTIAL_OR_OMITTED_FAIL';
  END IF;
END $$;

-- On same-source updates, key omission preserves the last successful
-- per-listing retrieval while an explicit JSON null deliberately clears it.
SELECT public.bulk_import_scrape_events(
  (SELECT id FROM _freshness_fx WHERE key = 'run_a'),
  (SELECT id FROM _freshness_fx WHERE key = 'source_a'),
  jsonb_build_array(
    pg_temp.event_payload(
      'Unchanged success',
      'https://source-a.example/unchanged',
      'Freshness source A',
      '2026-06-03T13:30:00+00'
    ) - 'source_details_fetched_at'
  )
);

DO $$
BEGIN
  IF (SELECT source_details_fetched_at
        FROM public.events
       WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
         AND source_url = 'https://source-a.example/unchanged')
       IS DISTINCT FROM '2026-06-02T13:30:00.654321+00'::timestamptz
  THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_OMITTED_KEY_DID_NOT_PRESERVE';
  END IF;
END $$;

SELECT public.bulk_import_scrape_events(
  (SELECT id FROM _freshness_fx WHERE key = 'run_a'),
  (SELECT id FROM _freshness_fx WHERE key = 'source_a'),
  jsonb_build_array(
    pg_temp.event_payload(
      'Unchanged success',
      'https://source-a.example/unchanged',
      'Freshness source A',
      NULL
    )
  )
);

DO $$
BEGIN
  IF (SELECT source_details_fetched_at
        FROM public.events
       WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
         AND source_url = 'https://source-a.example/unchanged') IS NOT NULL
  THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_EXPLICIT_NULL_DID_NOT_CLEAR';
  END IF;
END $$;

-- Restore a successful retrieval so the remaining assertions continue to prove
-- that unrelated bookkeeping and cross-source writes preserve a known value.
SELECT public.bulk_import_scrape_events(
  (SELECT id FROM _freshness_fx WHERE key = 'run_a'),
  (SELECT id FROM _freshness_fx WHERE key = 'source_a'),
  jsonb_build_array(
    pg_temp.event_payload(
      'Unchanged success',
      'https://source-a.example/unchanged',
      'Freshness source A',
      '2026-06-02T13:30:00.654321+00'
    )
  )
);

-- A malformed per-listing timestamp rejects the write instead of borrowing a
-- run-level time or erasing the prior successful retrieval.
DO $$
BEGIN
  BEGIN
    PERFORM public.bulk_import_scrape_events(
      (SELECT id FROM _freshness_fx WHERE key = 'run_a'),
      (SELECT id FROM _freshness_fx WHERE key = 'source_a'),
      jsonb_build_array(
        pg_temp.event_payload(
          'Later failed',
          'https://source-a.example/failed',
          'Freshness source A',
          'not-a-timestamp'
        )
      )
    );
    RAISE EXCEPTION 'SOURCE_FRESHNESS_INVALID_TIMESTAMP_ACCEPTED';
  EXCEPTION
    WHEN invalid_datetime_format THEN NULL;
  END;

  IF (SELECT source_details_fetched_at
        FROM public.events
       WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
         AND source_url = 'https://source-a.example/failed')
       IS DISTINCT FROM '2026-06-01T12:00:00.123456+00'::timestamptz
  THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_FAILED_WRITE_CHANGED_VALUE';
  END IF;
END $$;

-- Source-wide bookkeeping has no path to listing-level freshness.
UPDATE public.source_runs
   SET completed_at = '2026-06-03T18:00:00+00',
       status = 'partial'
 WHERE id = (SELECT id FROM _freshness_fx WHERE key = 'run_a');
UPDATE public.event_sources
   SET last_scraped_at = '2026-06-03T18:00:00+00',
       last_status = 'partial'
 WHERE id = (SELECT id FROM _freshness_fx WHERE key = 'source_a');

DO $$
BEGIN
  IF (SELECT source_details_fetched_at
        FROM public.events
       WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
         AND source_url = 'https://source-a.example/unchanged')
       IS DISTINCT FROM '2026-06-02T13:30:00.654321+00'::timestamptz
  THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_RUN_BOOKKEEPING_FAIL';
  END IF;
END $$;

-- The same source URL under another source remains a distinct provenance
-- identity and cannot update source A's row.
SELECT public.bulk_import_scrape_events(
  (SELECT id FROM _freshness_fx WHERE key = 'run_b'),
  (SELECT id FROM _freshness_fx WHERE key = 'source_b'),
  jsonb_build_array(
    pg_temp.event_payload(
      'Other source listing',
      'https://source-a.example/unchanged',
      'Freshness source B',
      '2026-06-04T09:00:00+00'
    )
  )
);

DO $$
BEGIN
  IF (SELECT count(*)
        FROM public.events
       WHERE source_url = 'https://source-a.example/unchanged') <> 2
  THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_SAME_SOURCE_IDENTITY_FAIL';
  END IF;

  IF (SELECT source_details_fetched_at
        FROM public.events
       WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
         AND source_url = 'https://source-a.example/unchanged')
       IS DISTINCT FROM '2026-06-02T13:30:00.654321+00'::timestamptz
  THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_CROSS_SOURCE_OVERWRITE_FAIL';
  END IF;
END $$;

-- Admin edits neither accept the ingestion-owned field nor alter populated or
-- unknown values.
INSERT INTO auth.users (id, email, aud, role, instance_id)
SELECT id, 'freshness-admin@test.local', 'authenticated', 'authenticated',
       '00000000-0000-0000-0000-000000000000'
FROM _freshness_fx WHERE key = 'admin';
INSERT INTO public.user_profiles (id, email, display_name, role)
SELECT id, 'freshness-admin@test.local', 'Freshness admin', 'admin'
FROM _freshness_fx WHERE key = 'admin'
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  display_name = EXCLUDED.display_name,
  role = EXCLUDED.role;
INSERT INTO public.user_access (user_id, is_enabled, enabled_at)
SELECT id, true, now() FROM _freshness_fx WHERE key = 'admin'
ON CONFLICT (user_id) DO UPDATE SET
  is_enabled = EXCLUDED.is_enabled,
  enabled_at = EXCLUDED.enabled_at,
  access_expires_at = NULL;

DO $$
DECLARE
  admin_id uuid := (SELECT id FROM _freshness_fx WHERE key = 'admin');
  populated_id uuid := (
    SELECT id FROM public.events
     WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
       AND source_url = 'https://source-a.example/unchanged'
  );
  unknown_id uuid := (SELECT id FROM public.events WHERE title = 'Manual fixture');
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);

  PERFORM public.admin_update_event_status(
    populated_id, 'published', 'Freshness preservation fixture'
  );
  PERFORM public.admin_update_event_status(
    unknown_id, 'draft', 'Freshness preservation fixture'
  );

  BEGIN
    PERFORM public.admin_update_event(
      populated_id,
      '{"source_details_fetched_at":"2026-06-05T00:00:00+00"}'::jsonb,
      '{}'::uuid[],
      true,
      NULL
    );
    RAISE EXCEPTION 'SOURCE_FRESHNESS_ADMIN_FIELD_ACCEPTED';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'ADMIN_EVENT_UNKNOWN_FIELD' THEN
        RAISE;
      END IF;
  END;

  RESET ROLE;

  IF (SELECT source_details_fetched_at FROM public.events WHERE id = populated_id)
       IS DISTINCT FROM '2026-06-02T13:30:00.654321+00'::timestamptz
     OR (SELECT source_details_fetched_at FROM public.events WHERE id = unknown_id) IS NOT NULL
  THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_ADMIN_EDIT_FAIL';
  END IF;
END $$;

-- The public read RPC returns the typed value directly, including exact
-- microseconds and NULL.
DO $$
DECLARE
  populated_id uuid := (
    SELECT id FROM public.events
     WHERE source_id = (SELECT id FROM _freshness_fx WHERE key = 'source_a')
       AND source_url = 'https://source-a.example/unchanged'
  );
  unknown_id uuid := (SELECT id FROM public.events WHERE title = 'Manual fixture');
  fetched_at timestamptz;
BEGIN
  SELECT source_details_fetched_at
    INTO fetched_at
    FROM public.events_enriched(p_event_ids := ARRAY[populated_id])
   WHERE id = populated_id;

  IF fetched_at IS DISTINCT FROM '2026-06-02T13:30:00.654321+00'::timestamptz THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_ENRICHED_VALUE_FAIL: %', fetched_at;
  END IF;

  SELECT source_details_fetched_at
    INTO fetched_at
    FROM public.events_enriched(p_event_ids := ARRAY[unknown_id])
   WHERE id = unknown_id;

  IF fetched_at IS NOT NULL THEN
    RAISE EXCEPTION 'SOURCE_FRESHNESS_ENRICHED_NULL_FAIL: %', fetched_at;
  END IF;
END $$;

ROLLBACK;
