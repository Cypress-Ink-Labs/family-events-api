-- event_tag_queue worker RPCs, extracted VERBATIM from
-- family-events-backend 20260601000000_schema_baseline.sql (U29).
-- GRANT/REVOKE/ALTER FUNCTION ... OWNER TO statements omitted: the bare test
-- database has no anon/authenticated/service_role roles and no "postgres"
-- superuser to reassign ownership to.
--
-- Deliberately NOT included: public.invoke_process_tag_queue. The real
-- implementation fires net.http_post (pg_net) at the deployed
-- process-tag-queue edge function, which a disposable test database can
-- neither install nor reach; ingestion-catalog.ts installs a no-op stub
-- instead (see its doc comment).

CREATE OR REPLACE FUNCTION "private"."claim_tag_queue_batch"("p_limit" integer DEFAULT 20) RETURNS SETOF "public"."event_tag_queue"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  RETURN QUERY
  UPDATE public.event_tag_queue q SET
    status = 'processing',
    started_at = NULL
  WHERE q.id IN (
    SELECT inner_q.id
    FROM public.event_tag_queue inner_q
    WHERE inner_q.status = 'pending'
      AND inner_q.next_attempt_at <= now()
    ORDER BY inner_q.next_attempt_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 100))
  )
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION "private"."mark_tag_queue_row_started"("p_queue_id" bigint) RETURNS "public"."event_tag_queue"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_row public.event_tag_queue;
BEGIN
  UPDATE public.event_tag_queue
  SET started_at = now(),
      attempt_count = attempt_count + 1
  WHERE id = p_queue_id
    AND status = 'processing'
    AND started_at IS NULL
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION "private"."reap_stuck_tag_queue_rows"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.event_tag_queue
  SET status = 'pending',
      started_at = NULL,
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

CREATE OR REPLACE FUNCTION "private"."release_unstarted_tag_queue_rows"("p_claimed_ids" bigint[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.event_tag_queue
  SET status = 'pending',
      started_at = NULL
  WHERE id = ANY(p_claimed_ids)
    AND status = 'processing'
    AND started_at IS NULL
    AND finished_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."claim_tag_queue_batch"("p_limit" integer DEFAULT 5) RETURNS SETOF "public"."event_tag_queue"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT * FROM private.claim_tag_queue_batch(p_limit); $$;

CREATE OR REPLACE FUNCTION "public"."mark_tag_queue_row_started"("p_queue_id" bigint) RETURNS "public"."event_tag_queue"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT private.mark_tag_queue_row_started(p_queue_id); $$;

CREATE OR REPLACE FUNCTION "public"."reap_stuck_tag_queue_rows"() RETURNS integer
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT private.reap_stuck_tag_queue_rows(); $$;

CREATE OR REPLACE FUNCTION "public"."release_unstarted_tag_queue_rows"("p_claimed_ids" bigint[]) RETURNS integer
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$ SELECT private.release_unstarted_tag_queue_rows(p_claimed_ids); $$;
