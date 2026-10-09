-- Notify community event submitters when their event is approved or rejected.
-- Frozen backend 8f83f810547982070d653b64c740c0f4a12b55e9, migration 20260601035000.
-- Uses pg_net to call the notify-email edge function (fire-and-forget).
-- Only fires for events with submitted_by IS NOT NULL (community events).

CREATE OR REPLACE FUNCTION private.notify_community_event_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_submitter_email text;
  v_submitter_name text;
  v_kind text;
  v_supabase_url text;
  v_service_role_key text;
  v_payload jsonb;
  v_app_url text;
BEGIN
  -- Only fire for community events (submitted_by IS NOT NULL)
  IF NEW.submitted_by IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only fire on status transitions to published or rejected
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status::text = 'published' THEN
    v_kind := 'community_event_approved';
  ELSIF NEW.status::text = 'rejected' THEN
    v_kind := 'community_event_rejected';
  ELSE
    RETURN NEW;
  END IF;

  -- Look up submitter email and name
  SELECT
    au.email,
    COALESCE(up.display_name, split_part(au.email, '@', 1))
  INTO v_submitter_email, v_submitter_name
  FROM auth.users au
  LEFT JOIN public.user_profiles up ON up.id = au.id
  WHERE au.id = NEW.submitted_by;

  IF v_submitter_email IS NULL THEN
    RETURN NEW;
  END IF;

  -- Read Supabase config
  v_supabase_url := COALESCE(
    current_setting('app.settings.supabase_url', true),
    ''
  );
  v_service_role_key := COALESCE(
    current_setting('app.settings.service_role_key', true),
    ''
  );
  v_app_url := COALESCE(
    current_setting('app.settings.app_url', true),
    'https://family-events.org'
  );

  IF v_supabase_url = '' OR v_service_role_key = '' THEN
    RAISE NOTICE 'Skipping community event notification: missing supabase_url or service_role_key';
    RETURN NEW;
  END IF;

  -- Build payload
  v_payload := jsonb_build_object(
    'kind', v_kind,
    'email', v_submitter_email,
    'username', v_submitter_name,
    'event_title', NEW.title,
    'event_id', NEW.id::text,
    'app_url', v_app_url
  );

  -- Fire-and-forget via pg_net
  PERFORM net.http_post(
    url := v_supabase_url || '/functions/v1/notify-email',
    body := v_payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_role_key,
      'apikey', v_service_role_key
    )
  );

  RETURN NEW;
END;
$$;

-- Attach trigger to events table
DROP TRIGGER IF EXISTS trg_notify_community_event_status ON public.events;
CREATE TRIGGER trg_notify_community_event_status
  AFTER UPDATE OF status ON public.events
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION private.notify_community_event_status();
