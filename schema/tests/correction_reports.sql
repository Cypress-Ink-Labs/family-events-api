BEGIN;
CREATE OR REPLACE FUNCTION private.is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;

DO $$
DECLARE
  event_id uuid := '10000000-0000-4000-8000-000000000001';
  report_id uuid := '20000000-0000-4000-8000-000000000001';
  corrected_report_id uuid := '20000000-0000-4000-8000-000000000002';
  operator_id uuid := '30000000-0000-4000-8000-000000000001';
  audit_id uuid;
  before_event jsonb;
  after_event jsonb;
  claimed public.correction_reports;
  correction public.listing_corrections;
  resolved public.correction_reports;
BEGIN
  ASSERT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'correction_reports');
  ASSERT to_regclass('private.correction_report_private') IS NOT NULL;
  ASSERT to_regclass('public.correction_report_private') IS NULL;
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.correction_reports'::regclass);
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.listing_corrections'::regclass);
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.correction_reports'::regclass
      AND confrelid = 'private.correction_report_capabilities'::regclass
  ), 'anonymous capabilities must never identify reports';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.correction_reports'::regclass AND NOT tgisinternal
  ), 'reports must not mutate listings through triggers';
  ASSERT has_function_privilege('anon', 'private.claim_correction_report(uuid,uuid,integer)', 'EXECUTE') = false;
  ASSERT has_function_privilege('anon', 'private.link_listing_correction(uuid,uuid,uuid,uuid,text)', 'EXECUTE') = false;
  ASSERT has_function_privilege('authenticated', 'private.resolve_correction_report(uuid,uuid,integer,public.correction_report_status,text,uuid)', 'EXECUTE') = false;
  ASSERT has_function_privilege('service_role', 'private.claim_correction_report(uuid,uuid,integer)', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'private.link_listing_correction(uuid,uuid,uuid,uuid,text)', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'private.resolve_correction_report(uuid,uuid,integer,public.correction_report_status,text,uuid)', 'EXECUTE');
  ASSERT has_table_privilege('anon', 'private.correction_report_private', 'SELECT') = false;
  ASSERT has_table_privilege('anon', 'public.correction_reports', 'INSERT') = false;
  ASSERT has_table_privilege('authenticated', 'public.correction_reports', 'SELECT') = false;
  ASSERT has_table_privilege('authenticated', 'private.correction_report_private', 'INSERT') = false;
  ASSERT has_table_privilege('anon', 'private.correction_report_capabilities', 'SELECT') = false;
  ASSERT has_table_privilege('authenticated', 'private.correction_report_recent_content', 'UPDATE') = false;
  ASSERT has_table_privilege('service_role', 'private.correction_report_private', 'SELECT');
  ASSERT has_table_privilege('service_role', 'public.correction_reports', 'INSERT');
  ASSERT (
    SELECT proconfig @> ARRAY['search_path=pg_catalog, public, private']
    FROM pg_proc
    WHERE oid = 'private.resolve_correction_report(uuid,uuid,integer,public.correction_report_status,text,uuid)'::regprocedure
  );
  ASSERT (
    SELECT pg_get_functiondef(
      'private.link_listing_correction(uuid,uuid,uuid,uuid,text)'::regprocedure
    )
  ) LIKE '%a.target_id::text = p_event_id::text%';
  ASSERT (
    SELECT pg_get_functiondef(
      'private.resolve_correction_report(uuid,uuid,integer,public.correction_report_status,text,uuid)'::regprocedure
    )
  ) LIKE '%a.id = c.audit_log_id%';

  INSERT INTO auth.users (id, email, aud, role, instance_id)
  VALUES (
    operator_id, 'correction-schema@example.com', 'authenticated', 'authenticated',
    '00000000-0000-0000-0000-000000000000'
  );
  INSERT INTO public.events (id, title, start_datetime, status, is_free)
  VALUES (event_id, 'Correction workflow fixture', '2099-01-01T12:00:00Z', 'published', true);
  INSERT INTO public.correction_reports (id, event_id, category, details)
  VALUES (report_id, event_id, 'wrong_date_time', 'Starts later');
  SELECT to_jsonb(e) INTO before_event FROM public.events e WHERE id = event_id;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', operator_id, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM private.claim_correction_report(
      report_id, '30000000-0000-4000-8000-000000000002', 1
    );
    ASSERT false, 'operator attribution must match the authenticated actor';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  claimed := private.claim_correction_report(report_id, operator_id, 1);
  ASSERT claimed.status = 'in_review' AND claimed.version = 2;
  BEGIN
    PERFORM private.claim_correction_report(report_id, operator_id, 1);
    ASSERT false, 'a concurrent/stale claim must lose';
  EXCEPTION WHEN serialization_failure THEN
    NULL;
  END;

  BEGIN
    PERFORM private.resolve_correction_report(
      report_id, operator_id, 2, 'resolved', 'fixed', NULL
    );
    ASSERT false, 'resolved disposition must have an audit-linked correction';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    PERFORM private.link_listing_correction(
      report_id, event_id, operator_id,
      '40000000-0000-4000-8000-000000000001', 'not backed by an audit edit'
    );
    ASSERT false, 'correction linkage must require a committed matching audit edit';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  resolved := private.resolve_correction_report(
    report_id, operator_id, 2, 'dismissed', 'No listing change needed', NULL
  );
  ASSERT resolved.status = 'dismissed' AND resolved.version = 3;
  BEGIN
    PERFORM private.resolve_correction_report(
      report_id, operator_id, 2, 'dismissed', 'stale reviewer', NULL
    );
    ASSERT false, 'a concurrent/stale resolution must lose';
  EXCEPTION WHEN serialization_failure THEN
    NULL;
  END;

  SELECT to_jsonb(e) INTO after_event FROM public.events e WHERE id = event_id;
  ASSERT before_event = after_event, 'claiming and resolving a report must not mutate its event';

  INSERT INTO public.correction_reports (
    id, event_id, category, details, created_at
  ) VALUES (
    corrected_report_id, event_id, 'wrong_location', 'The venue changed.',
    clock_timestamp() - interval '1 minute'
  );
  INSERT INTO private.correction_report_private (report_id, contact, evidence)
  VALUES (
    corrected_report_id,
    '{"email":"private@example.com"}'::jsonb,
    ARRAY['https://example.com/correction']
  );
  claimed := private.claim_correction_report(corrected_report_id, operator_id, 1);
  ASSERT claimed.status = 'in_review' AND claimed.version = 2;

  UPDATE public.events
  SET address = '2 Corrected Ave'
  WHERE id = event_id;
  INSERT INTO public.admin_audit_log (
    admin_user_id, action, target_type, target_id, metadata, created_at
  ) VALUES (
    operator_id,
    'event.update',
    'event',
    event_id,
    jsonb_build_object(
      'patch', jsonb_build_object('address', '2 Corrected Ave'),
      'changed_fields', jsonb_build_array('address')
    ),
    clock_timestamp()
  )
  RETURNING id INTO audit_id;

  correction := private.link_listing_correction(
    corrected_report_id,
    event_id,
    operator_id,
    audit_id,
    'Updated the event address from the operator report.'
  );
  resolved := private.resolve_correction_report(
    corrected_report_id,
    operator_id,
    2,
    'resolved',
    'Corrected the event address.',
    correction.id
  );
  ASSERT resolved.status = 'resolved'
    AND resolved.correction_id = correction.id
    AND resolved.version = 3,
    'a committed event update must link and resolve atomically by version';
  ASSERT NOT EXISTS (
    SELECT 1
    FROM private.correction_report_private payload
    WHERE payload.report_id = corrected_report_id
  ), 'terminal resolution must purge private contact and evidence';
END $$;
ROLLBACK;
