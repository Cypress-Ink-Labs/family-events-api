-- event_llm_review_queue worker RPCs, extracted VERBATIM from
-- family-events-backend migrations (U29). GRANT/REVOKE/ALTER FUNCTION ...
-- OWNER TO/COMMENT ON statements omitted: the bare test database has no
-- anon/authenticated/service_role roles and no "postgres" superuser to
-- reassign ownership to.
--
-- Function sources (latest version wins):
--   claim_event_llm_review_queue_batch: 20260601004000_llm_review_and_enrichment.sql
--   mark_event_llm_review_queue_row_started: 20260601004000_llm_review_and_enrichment.sql
--   release_unstarted_event_llm_review_rows: 20260601004000_llm_review_and_enrichment.sql
--   reap_stuck_event_llm_review_rows: 20260823000000_fix_queue_reap_claim_staleness.sql
--   apply_event_llm_review_decision: 20260601017000_event_status_enum_and_validate_checks.sql
--   should_auto_reject_source: 20260601022000_source_auto_reject_and_stats.sql

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 280-305
CREATE OR REPLACE FUNCTION private.claim_event_llm_review_queue_batch(
  p_limit integer DEFAULT 20
)
RETURNS SETOF public.event_llm_review_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.event_llm_review_queue q
  SET status = 'processing',
      started_at = NULL,
      updated_at = now()
  WHERE q.id IN (
    SELECT i.id
    FROM public.event_llm_review_queue i
    WHERE i.status IN ('pending', 'retrying')
      AND i.next_attempt_at <= now()
    ORDER BY i.next_attempt_at, i.enqueued_at, i.id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 100))
  )
  RETURNING *;
END;
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 307-316
CREATE OR REPLACE FUNCTION public.claim_event_llm_review_queue_batch(
  p_limit integer DEFAULT 20
)
RETURNS SETOF public.event_llm_review_queue
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT * FROM private.claim_event_llm_review_queue_batch(p_limit);
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 318-340
CREATE OR REPLACE FUNCTION private.mark_event_llm_review_queue_row_started(
  p_queue_id bigint
)
RETURNS public.event_llm_review_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_row public.event_llm_review_queue;
BEGIN
  UPDATE public.event_llm_review_queue
  SET started_at = now(),
      attempt_count = attempt_count + 1,
      updated_at = now()
  WHERE id = p_queue_id
    AND status = 'processing'
    AND started_at IS NULL
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 342-351
CREATE OR REPLACE FUNCTION public.mark_event_llm_review_queue_row_started(
  p_queue_id bigint
)
RETURNS public.event_llm_review_queue
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT private.mark_event_llm_review_queue_row_started(p_queue_id);
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 353-376
CREATE OR REPLACE FUNCTION private.release_unstarted_event_llm_review_rows(
  p_claimed_ids bigint[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.event_llm_review_queue
  SET status = 'pending',
      started_at = NULL,
      updated_at = now()
  WHERE id = ANY(p_claimed_ids)
    AND status = 'processing'
    AND started_at IS NULL
    AND finished_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 378-387
CREATE OR REPLACE FUNCTION public.release_unstarted_event_llm_review_rows(
  p_claimed_ids bigint[]
)
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT private.release_unstarted_event_llm_review_rows(p_claimed_ids);
$$;

-- Source: 20260823000000_fix_queue_reap_claim_staleness.sql
CREATE OR REPLACE FUNCTION private.reap_stuck_event_llm_review_rows()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.event_llm_review_queue
  SET status = 'retrying',
      started_at = NULL,
      last_error = COALESCE(last_error, 'reaped after stuck in processing'),
      updated_at = now()
  WHERE status = 'processing'
    AND (
      (started_at IS NULL AND updated_at < now() - interval '5 minutes')
      OR started_at < now() - interval '15 minutes'
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 414-421
CREATE OR REPLACE FUNCTION public.reap_stuck_event_llm_review_rows()
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT private.reap_stuck_event_llm_review_rows();
$$;

-- Source: 20260601017000_event_status_enum_and_validate_checks.sql (supersedes 20260601004000)
CREATE OR REPLACE FUNCTION private.apply_event_llm_review_decision(p_queue_id bigint, p_event_id uuid, p_source_id uuid, p_source_run_id uuid, p_provider text, p_model text, p_prompt_version text, p_review_status llm_event_review_status, p_model_decision llm_event_review_decision, p_applied_decision llm_event_review_decision, p_confidence numeric, p_reason text, p_flags text[], p_suggested_category text, p_normalized_title text, p_raw_response jsonb, p_error_code text, p_error_message text, p_input_snapshot jsonb, p_processing_ms integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_event_id uuid;
  v_next_event_status text;
  v_now timestamptz := now();
BEGIN
  v_next_event_status := CASE
    WHEN p_applied_decision = 'approve'::public.llm_event_review_decision THEN 'published'
    WHEN p_applied_decision = 'reject'::public.llm_event_review_decision THEN 'rejected'
    ELSE 'draft'
  END;

  UPDATE public.events
  SET status = v_next_event_status::public.event_status,
      llm_review_status = p_review_status,
      llm_review_decision = p_applied_decision,
      llm_review_confidence = p_confidence,
      llm_review_reason = p_reason,
      llm_review_flags = COALESCE(p_flags, '{}'::text[]),
      llm_review_provider = p_provider,
      llm_review_model = p_model,
      llm_review_prompt_version = p_prompt_version,
      llm_reviewed_at = v_now,
      llm_review_error = p_error_message,
      updated_at = v_now
  WHERE id = p_event_id
    AND status = 'draft'
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.event_llm_review_traces (
    event_id,
    queue_id,
    source_id,
    source_run_id,
    provider,
    model,
    prompt_version,
    status,
    model_decision,
    applied_decision,
    confidence,
    reason,
    flags,
    suggested_category,
    normalized_title,
    raw_response,
    error_code,
    error_message,
    input_snapshot,
    processing_ms
  )
  VALUES (
    p_event_id,
    p_queue_id,
    p_source_id,
    p_source_run_id,
    p_provider,
    p_model,
    p_prompt_version,
    p_review_status,
    p_model_decision,
    p_applied_decision,
    p_confidence,
    p_reason,
    COALESCE(p_flags, '{}'::text[]),
    p_suggested_category,
    p_normalized_title,
    p_raw_response,
    p_error_code,
    p_error_message,
    p_input_snapshot,
    p_processing_ms
  );

  IF p_applied_decision <> 'reject'::public.llm_event_review_decision THEN
    INSERT INTO public.event_tag_queue (event_id, source_run_id, trigger_type)
    VALUES (p_event_id, p_source_run_id, 'import')
    ON CONFLICT (event_id) WHERE status IN ('pending', 'processing')
      DO NOTHING;
  END IF;

  UPDATE public.event_llm_review_queue
  SET status = 'succeeded',
      finished_at = v_now,
      last_error = NULL,
      updated_at = v_now
  WHERE id = p_queue_id;

  RETURN true;
END;
$function$;

-- Source: 20260601004000_llm_review_and_enrichment.sql lines 1299-1348
CREATE OR REPLACE FUNCTION public.apply_event_llm_review_decision(
  p_queue_id bigint,
  p_event_id uuid,
  p_source_id uuid,
  p_source_run_id uuid,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_review_status public.llm_event_review_status,
  p_model_decision public.llm_event_review_decision,
  p_applied_decision public.llm_event_review_decision,
  p_confidence numeric,
  p_reason text,
  p_flags text[],
  p_suggested_category text,
  p_normalized_title text,
  p_raw_response jsonb,
  p_error_code text,
  p_error_message text,
  p_input_snapshot jsonb,
  p_processing_ms integer
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT private.apply_event_llm_review_decision(
    p_queue_id,
    p_event_id,
    p_source_id,
    p_source_run_id,
    p_provider,
    p_model,
    p_prompt_version,
    p_review_status,
    p_model_decision,
    p_applied_decision,
    p_confidence,
    p_reason,
    p_flags,
    p_suggested_category,
    p_normalized_title,
    p_raw_response,
    p_error_code,
    p_error_message,
    p_input_snapshot,
    p_processing_ms
  );
$$;

-- Source: 20260601022000_source_auto_reject_and_stats.sql lines 13-37
CREATE OR REPLACE FUNCTION private.should_auto_reject_source(
  p_source_id uuid,
  p_threshold float DEFAULT 0.8,
  p_min_events int DEFAULT 5,
  p_window_days int DEFAULT 30
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT COALESCE(
    (
      SELECT (count(*) FILTER (WHERE e.status = 'rejected'::public.event_status))::float
             / GREATEST(count(*), 1) > p_threshold
      FROM public.events e
      WHERE e.source_id = p_source_id
        AND e.status IN ('published'::public.event_status, 'rejected'::public.event_status)
        AND e.updated_at >= now() - (p_window_days || ' days')::interval
      HAVING count(*) >= p_min_events
    ),
    false
  );
$$;

-- Source: 20260601022000_source_auto_reject_and_stats.sql lines 45-57
CREATE OR REPLACE FUNCTION public.should_auto_reject_source(
  p_source_id uuid,
  p_threshold float DEFAULT 0.8,
  p_min_events int DEFAULT 5,
  p_window_days int DEFAULT 30
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT private.should_auto_reject_source(p_source_id, p_threshold, p_min_events, p_window_days);
$$;
