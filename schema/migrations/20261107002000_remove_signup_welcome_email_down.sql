-- Restore the welcome email dispatch for non-Clerk signups.
DO $migration$
DECLARE
  definition text;
  changed text;
BEGIN
  SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) INTO definition;

  changed := replace(
    definition,
    $old$  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
$old$,
    $new$  ON CONFLICT (user_id) DO NOTHING;

  IF NEW.raw_app_meta_data->>'provider' IS DISTINCT FROM 'clerk' THEN
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

  RETURN NEW;
$new$
  );
  IF changed = definition THEN
    RAISE EXCEPTION 'signup welcome email rollback could not find the insertion point';
  END IF;

  EXECUTE changed;
END;
$migration$;
