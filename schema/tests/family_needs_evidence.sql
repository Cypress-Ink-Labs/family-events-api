BEGIN;
DO $$
BEGIN
  ASSERT to_regtype('public.family_need_claim') IS NOT NULL;
  ASSERT to_regclass('public.event_family_need_evidence') IS NOT NULL;
  ASSERT to_regclass('public.event_family_needs') IS NOT NULL;
  ASSERT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events'
      AND column_name = 'parking_details' AND is_nullable = 'YES'
  );
  ASSERT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events'
      AND column_name = 'reservation_details' AND is_nullable = 'YES'
  );
  ASSERT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.events'::regclass
      AND tgname = 'invalidate_material_family_need_evidence'
      AND NOT tgisinternal
  );
  ASSERT (
    SELECT attnotnull
    FROM pg_attribute
    WHERE attrelid = 'public.event_family_need_evidence'::regclass
      AND attname = 'statement'
  );
  ASSERT (
    SELECT attnotnull
    FROM pg_attribute
    WHERE attrelid = 'public.event_family_need_evidence'::regclass
      AND attname = 'observed_at'
  );
  ASSERT NOT (
    SELECT attnotnull
    FROM pg_attribute
    WHERE attrelid = 'public.event_family_need_evidence'::regclass
      AND attname = 'recorded_by'
  );
  ASSERT NOT (
    SELECT attnotnull
    FROM pg_attribute
    WHERE attrelid = 'public.event_family_need_evidence'::regclass
      AND attname = 'invalidated_at'
  );
  ASSERT (
    SELECT count(*) = 2
    FROM pg_constraint
    WHERE conrelid = 'public.event_family_need_evidence'::regclass
      AND contype = 'f'
      AND conkey[1] IN (
        SELECT attnum
        FROM pg_attribute
        WHERE attrelid = 'public.event_family_need_evidence'::regclass
          AND attname IN ('event_id', 'recorded_by')
      )
  );
  ASSERT NOT has_table_privilege('anon', 'public.event_family_need_evidence', 'SELECT');
  ASSERT NOT has_table_privilege(
    'authenticated',
    'public.event_family_need_evidence',
    'SELECT'
  );
  ASSERT has_table_privilege(
    'service_role',
    'public.event_family_need_evidence',
    'SELECT,INSERT,UPDATE'
  );
  ASSERT NOT has_table_privilege(
    'service_role',
    'public.event_family_need_evidence',
    'DELETE'
  );
  ASSERT NOT has_table_privilege(
    'service_role',
    'public.event_family_need_evidence',
    'TRUNCATE'
  );
  ASSERT (
    SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
      'event_id', 'claim', 'state', 'value', 'has_conflict'
    ]
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_family_needs'
  );
  ASSERT pg_get_functiondef(
    'public.events_enriched(uuid,text,uuid,uuid[],timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure
  ) LIKE '%parking_details text, reservation_details text%';
  ASSERT pg_get_functiondef(
    'private.bulk_import_scrape_events(uuid,uuid,jsonb)'::regprocedure
  ) LIKE '%parking_details%reservation_details%';
  ASSERT pg_get_functiondef(
    'private.admin_update_event(uuid,jsonb,uuid[],boolean,text)'::regprocedure
  ) LIKE '%next_parking_details%next_reservation_details%';
END $$;
ROLLBACK;
