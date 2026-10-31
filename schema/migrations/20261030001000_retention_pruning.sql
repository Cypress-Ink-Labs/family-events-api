-- Retention for the tables that grew past the 500 MB free-tier cap. Runs from
-- the API's daily maintenance after public.run_daily_maintenance(). One call
-- deletes at most p_batch_size rows per table so each statement stays short;
-- the caller repeats it until a pass deletes less than a full batch.
CREATE FUNCTION private.run_retention(p_batch_size integer DEFAULT 5000) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_ai_traces          integer;
  v_review_traces      integer;
  v_review_queue       integer;
  v_tag_queue          integer;
  v_extraction_traces  integer;
  v_cron_log_entries   integer;
  v_railway_cron_runs  integer;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 THEN
    RAISE EXCEPTION 'retention batch size must be positive';
  END IF;

  DELETE FROM public.event_ai_traces
  WHERE id IN (
    SELECT id FROM public.event_ai_traces
    WHERE created_at < now() - interval '14 days'
    LIMIT p_batch_size
  );
  GET DIAGNOSTICS v_ai_traces = ROW_COUNT;

  -- Traces go before the queue rows they reference.
  DELETE FROM public.event_llm_review_traces
  WHERE id IN (
    SELECT t.id FROM public.event_llm_review_traces t
    WHERE t.created_at < now() - interval '14 days'
       OR EXISTS (
         SELECT 1 FROM public.event_llm_review_queue q
         WHERE q.id = t.queue_id
           AND q.status = 'succeeded'
           AND q.finished_at < now() - interval '14 days'
       )
    LIMIT p_batch_size
  );
  GET DIAGNOSTICS v_review_traces = ROW_COUNT;

  -- A queue row waits until its traces are gone, so none is orphaned or kept by
  -- a foreign key when a trace backlog spans several batches.
  DELETE FROM public.event_llm_review_queue
  WHERE id IN (
    SELECT q.id FROM public.event_llm_review_queue q
    WHERE q.status = 'succeeded'
      AND q.finished_at < now() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM public.event_llm_review_traces t WHERE t.queue_id = q.id
      )
    LIMIT p_batch_size
  );
  GET DIAGNOSTICS v_review_queue = ROW_COUNT;

  DELETE FROM public.event_tag_queue
  WHERE id IN (
    SELECT id FROM public.event_tag_queue
    WHERE status = 'succeeded' AND finished_at < now() - interval '14 days'
    LIMIT p_batch_size
  );
  GET DIAGNOSTICS v_tag_queue = ROW_COUNT;

  DELETE FROM public.source_extraction_traces
  WHERE id IN (
    SELECT id FROM public.source_extraction_traces
    WHERE created_at < now() - interval '30 days'
    LIMIT p_batch_size
  );
  GET DIAGNOSTICS v_extraction_traces = ROW_COUNT;

  DELETE FROM private.cron_run_log_entries
  WHERE id IN (
    SELECT id FROM private.cron_run_log_entries
    WHERE created_at < now() - interval '30 days'
    LIMIT p_batch_size
  );
  GET DIAGNOSTICS v_cron_log_entries = ROW_COUNT;

  DELETE FROM private.railway_cron_runs
  WHERE id IN (
    SELECT id FROM private.railway_cron_runs
    WHERE ran_at < now() - interval '30 days'
    LIMIT p_batch_size
  );
  GET DIAGNOSTICS v_railway_cron_runs = ROW_COUNT;

  RETURN jsonb_build_object(
    'event_ai_traces_pruned',            v_ai_traces,
    'event_llm_review_traces_pruned',    v_review_traces,
    'event_llm_review_queue_pruned',     v_review_queue,
    'event_tag_queue_succeeded_pruned',  v_tag_queue,
    'source_extraction_traces_pruned',   v_extraction_traces,
    'cron_run_log_entries_pruned',       v_cron_log_entries,
    'railway_cron_runs_pruned',          v_railway_cron_runs,
    'database_size_bytes',               pg_database_size(current_database())
  );
END;
$$;

REVOKE ALL ON FUNCTION private.run_retention(integer) FROM PUBLIC;

DO $grants$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION private.run_retention(integer) FROM %I', api_role);
    END IF;
  END LOOP;
END;
$grants$;
