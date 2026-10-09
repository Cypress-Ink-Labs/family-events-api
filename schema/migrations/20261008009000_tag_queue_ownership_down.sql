CREATE OR REPLACE FUNCTION "public"."invoke_process_tag_queue"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_supabase_url  text;
  v_service_role  text;
  v_reaped        int;
BEGIN
  -- Vault first (works on Supabase Cloud), GUC fallback (works locally).
  SELECT decrypted_secret INTO v_supabase_url
  FROM vault.decrypted_secrets
  WHERE name = 'supabase_project_url'
  LIMIT 1;

  IF v_supabase_url IS NULL THEN
    v_supabase_url := current_setting('app.settings.supabase_url', true);
  END IF;

  SELECT decrypted_secret INTO v_service_role
  FROM vault.decrypted_secrets
  WHERE name = 'scrape_service_role_key'
  LIMIT 1;

  IF v_service_role IS NULL THEN
    v_service_role := current_setting('app.settings.service_role_key', true);
  END IF;

  IF v_supabase_url IS NULL OR v_service_role IS NULL THEN
    RAISE NOTICE 'Skipping process-tag-queue: missing supabase_url or service_role_key';
    RETURN;
  END IF;

  -- Reap rows stuck in 'processing' for >5 min before checking the guard,
  -- so a crashed worker doesn't block the queue indefinitely.
  v_reaped := public.reap_stuck_tag_queue_rows();
  IF v_reaped > 0 THEN
    RAISE NOTICE 'reaped % stuck tag-queue rows', v_reaped;
  END IF;

  -- Skip if a batch is already running — prevents Ollama request pile-up.
  IF EXISTS (
    SELECT 1 FROM public.event_tag_queue WHERE status = 'processing' LIMIT 1
  ) THEN
    RAISE NOTICE 'process-tag-queue: batch already in flight, skipping tick';
    RETURN;
  END IF;

  -- Skip if nothing is pending.
  IF NOT EXISTS (
    SELECT 1 FROM public.event_tag_queue
    WHERE status = 'pending' AND next_attempt_at <= now()
    LIMIT 1
  ) THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url                  := v_supabase_url || '/functions/v1/process-tag-queue',
    headers              := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_role
    ),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
END;
$$;
