-- Production-derived disposable fixture.
-- Source: family-events-backend/supabase/migrations/20260601022000_source_auto_reject_and_stats.sql
-- Do not simplify: this must track the latest production private/public functions.

CREATE OR REPLACE FUNCTION private.pipeline_learning_stats(
  p_window_days int DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_window interval := (p_window_days || ' days')::interval;
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'window_days', p_window_days,
    'total_reviewed', (
      SELECT count(*) FROM public.events e
      WHERE e.status IN ('published'::public.event_status, 'rejected'::public.event_status)
        AND e.updated_at >= now() - v_window
    ),
    'llm_reviewed', (
      SELECT count(*) FROM public.event_llm_review_traces t
      WHERE t.status = 'succeeded' AND t.created_at >= now() - v_window
    ),
    'admin_reviewed', (
      SELECT count(*) FROM public.admin_event_decisions d
      WHERE d.decision_type IN ('status_change', 'status_and_tags')
        AND d.created_at >= now() - v_window
    ),
    'auto_rejected', (
      SELECT count(*) FROM public.event_llm_review_traces t
      WHERE 'source_auto_rejected' = ANY(t.flags) AND t.created_at >= now() - v_window
    ),
    'memory_hits', (
      SELECT count(*) FROM public.event_llm_review_traces t
      WHERE 'memory_context_used' = ANY(t.flags) AND t.created_at >= now() - v_window
    ),
    'total_embeddings', (SELECT count(*) FROM public.event_embeddings),
    'tag_memory_hits', (
      SELECT count(*) FROM public.event_ai_traces t
      WHERE t.predicted_fields->'memory_context'->>'used' = 'true'
        AND t.created_at >= now() - v_window
    ),
    'top_rejection_sources', (
      SELECT COALESCE(jsonb_agg(src ORDER BY src->>'rejection_rate' DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'source_id', e.source_id,
          'source_name', max(e.source_name),
          'total', count(*),
          'rejected', count(*) FILTER (WHERE e.status = 'rejected'::public.event_status),
          'rejection_rate', round(
            (count(*) FILTER (WHERE e.status = 'rejected'::public.event_status))::numeric
            / GREATEST(count(*), 1) * 100, 1
          )
        ) AS src
        FROM public.events e
        WHERE e.source_id IS NOT NULL
          AND e.status IN ('published'::public.event_status, 'rejected'::public.event_status)
          AND e.updated_at >= now() - v_window
        GROUP BY e.source_id
        HAVING count(*) >= 3
        ORDER BY (count(*) FILTER (WHERE e.status = 'rejected'::public.event_status))::float
          / GREATEST(count(*), 1) DESC
        LIMIT 10
      ) sub
    ),
    'feature_flags', (
      SELECT COALESCE(jsonb_object_agg(ac.feature, ac.enabled), '{}'::jsonb)
      FROM public.ai_feature_config ac
      WHERE ac.feature IN ('tag-memory', 'review-memory', 'source-auto-reject')
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION private.pipeline_learning_stats IS
  'Returns aggregate pipeline learning metrics for the admin dashboard. '
  'Includes review counts, memory hit rates, auto-reject counts, '
  'top rejection sources, and feature flag states.';

CREATE OR REPLACE FUNCTION public.pipeline_learning_stats(
  p_window_days int DEFAULT 30
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT private.pipeline_learning_stats(p_window_days);
$$;
