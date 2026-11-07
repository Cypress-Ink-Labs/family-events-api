-- Stop public.handle_new_user from sending the legacy welcome email. The
-- profile and access inserts, and the Clerk behaviour, are unchanged.
DO $migration$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) INTO definition;

  changed := replace(
    definition,
    $old$  IF NEW.raw_app_meta_data->>'provider' IS DISTINCT FROM 'clerk' THEN
  BEGIN
    PERFORM private.dispatch_email_notification(jsonb_build_object(
      'kind',     'welcome',
      'email',    NEW.email,
      'username', v_username
    ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to dispatch welcome email for %: %', NEW.email, SQLERRM;
  END;
  END IF;

$old$,
    ''
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'signup welcome email migration could not find the welcome email block';
  END IF;

  EXECUTE changed;
END;
$migration$;
