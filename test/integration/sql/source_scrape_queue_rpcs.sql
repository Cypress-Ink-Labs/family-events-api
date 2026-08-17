-- source_scrape_queue worker RPCs + stale-run cleanup, extracted VERBATIM from
-- family-events-backend 20260601000000_schema_baseline.sql (U28).
-- GRANT/REVOKE statements omitted: the bare test database has no anon/
-- authenticated/service_role roles.

CREATE OR REPLACE FUNCTION "private"."claim_source_scrape_queue_batch"("p_limit" integer DEFAULT 5) RETURNS SETOF "public"."source_scrape_queue"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  RETURN QUERY
  UPDATE public.source_scrape_queue q
  SET status = 'processing',
      started_at = NULL
  WHERE q.id IN (
    SELECT i.id
    FROM public.source_scrape_queue i
    WHERE i.status IN ('pending', 'retrying')
      AND i.next_attempt_at <= now()
    ORDER BY i.next_attempt_at, i.id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 25))
  )
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION "private"."mark_source_scrape_queue_skipped"("p_queue_id" bigint, "p_skip_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  UPDATE public.source_scrape_queue
  SET status = 'succeeded',
      finished_at = now(),
      skip_reason = left(coalesce(p_skip_reason, 'source skipped'), 1000),
      last_error = NULL
  WHERE id = p_queue_id;
END;
$$;

CREATE OR REPLACE FUNCTION "private"."mark_source_scrape_queue_started"("p_queue_id" bigint) RETURNS "public"."source_scrape_queue"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_row public.source_scrape_queue;
BEGIN
  UPDATE public.source_scrape_queue
  SET started_at = now(),
      attempt_count = attempt_count + 1
  WHERE id = p_queue_id
    AND status = 'processing'
    AND started_at IS NULL
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION "private"."reap_stuck_source_scrape_queue_rows"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.source_scrape_queue
  SET status = 'retrying',
      started_at = NULL,
      source_run_id = CASE WHEN started_at IS NULL THEN NULL ELSE source_run_id END,
      last_error = coalesce(last_error, 'reaped after stuck in processing')
  WHERE status = 'processing'
    AND (
      (started_at IS NULL  AND next_attempt_at < now() - interval '5 minutes')
      OR started_at < now() - interval '15 minutes'
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION "private"."release_unstarted_source_scrape_queue_rows"("p_claimed_ids" bigint[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.source_scrape_queue
  SET status = 'pending',
      started_at = NULL
  WHERE id = ANY(p_claimed_ids)
    AND status = 'processing'
    AND started_at IS NULL
    AND source_run_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION "private"."source_scrape_queue_schedule_retry"("p_queue_id" bigint, "p_attempt_count" integer, "p_error" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_next timestamptz;
BEGIN
  IF p_attempt_count >= 4 THEN
    UPDATE public.source_scrape_queue
    SET status = 'dead',
        finished_at = now(),
        last_error = left(coalesce(p_error, ''), 1000)
    WHERE id = p_queue_id;
    RETURN;
  END IF;

  v_next := CASE
    WHEN p_attempt_count = 1 THEN now() + interval '5 minutes'
    WHEN p_attempt_count = 2 THEN now() + interval '15 minutes'
    ELSE now() + interval '60 minutes'
  END;

  UPDATE public.source_scrape_queue
  SET status = 'pending',
      started_at = NULL,
      next_attempt_at = v_next,
      last_error = left(coalesce(p_error, ''), 1000)
  WHERE id = p_queue_id;
END;
$$;

CREATE OR REPLACE FUNCTION "private"."cleanup_stale_source_runs"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  UPDATE public.source_runs
  SET
    status      = 'error',
    completed_at = now(),
    error_log   = 'Run timed out — edge function did not complete within 15 minutes'
  WHERE status = 'running'
    AND started_at < now() - interval '15 minutes';

  -- Propagate to event_sources so the source card shows 'error' not 'pending'
  UPDATE public.event_sources es
  SET last_status = 'error'
  FROM public.source_runs sr
  WHERE sr.source_id = es.id
    AND sr.status = 'error'
    AND sr.error_log = 'Run timed out — edge function did not complete within 15 minutes'
    AND es.last_status = 'running';
END;
$$;

CREATE OR REPLACE FUNCTION "public"."claim_source_scrape_queue_batch"("p_limit" integer DEFAULT 5) RETURNS SETOF "public"."source_scrape_queue"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT * FROM private.claim_source_scrape_queue_batch(p_limit); $$;

CREATE OR REPLACE FUNCTION "public"."mark_source_scrape_queue_skipped"("p_queue_id" bigint, "p_skip_reason" "text") RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT private.mark_source_scrape_queue_skipped(p_queue_id, p_skip_reason); $$;

CREATE OR REPLACE FUNCTION "public"."mark_source_scrape_queue_started"("p_queue_id" bigint) RETURNS "public"."source_scrape_queue"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT private.mark_source_scrape_queue_started(p_queue_id); $$;

CREATE OR REPLACE FUNCTION "public"."reap_stuck_source_scrape_queue_rows"() RETURNS integer
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT private.reap_stuck_source_scrape_queue_rows(); $$;

CREATE OR REPLACE FUNCTION "public"."release_unstarted_source_scrape_queue_rows"("p_claimed_ids" bigint[]) RETURNS integer
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT private.release_unstarted_source_scrape_queue_rows(p_claimed_ids); $$;

CREATE OR REPLACE FUNCTION "public"."source_scrape_queue_schedule_retry"("p_queue_id" bigint, "p_attempt_count" integer, "p_error" "text") RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT private.source_scrape_queue_schedule_retry(p_queue_id, p_attempt_count, p_error); $$;

CREATE OR REPLACE FUNCTION "public"."run_due_source_scrapes"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  INSERT INTO public.source_scrape_queue (source_id, trigger_type)
  SELECT s.id, 'scheduled'
  FROM public.event_sources s
  WHERE s.is_active = true
    AND (
      s.last_scraped_at IS NULL
      OR s.last_scraped_at + make_interval(hours => s.scrape_interval_hours) <= now()
    )
  ON CONFLICT DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."run_cleanup_stale_runs"() RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
  SELECT private.cleanup_stale_source_runs();
$$;

