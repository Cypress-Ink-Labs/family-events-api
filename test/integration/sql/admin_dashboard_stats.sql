-- Production-derived disposable fixture.
-- Source: family-events-backend/supabase/migrations/20260610180000_admin_dashboard_stats.sql
-- Do not simplify: this must track the latest production private/public functions.
-- Production role grants are trimmed because the disposable server has no
-- authenticated or service_role roles.

CREATE OR REPLACE FUNCTION private.admin_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_events jsonb;
  v_ai jsonb;
  v_sources jsonb;
  v_dead jsonb;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT
    jsonb_build_object(
      'total', count(*),
      'draft', count(*) FILTER (WHERE status = 'draft'),
      'published', count(*) FILTER (WHERE status = 'published')
    ),
    jsonb_build_object(
      'high', count(*) FILTER (WHERE ai_confidence >= 0.9),
      'medium', count(*) FILTER (WHERE ai_confidence >= 0.7 AND ai_confidence < 0.9),
      'low', count(*) FILTER (WHERE ai_confidence IS NOT NULL AND ai_confidence < 0.7)
    )
  INTO v_events, v_ai
  FROM public.events;

  SELECT jsonb_build_object(
    'active', count(*) FILTER (WHERE is_active),
    -- only active sources count as errors, matching the previous client logic
    'errors', count(*) FILTER (WHERE is_active AND last_status = 'error')
  )
  INTO v_sources
  FROM public.event_sources;

  v_dead := jsonb_build_object(
    'tag_queue', (SELECT count(*) FROM public.event_tag_queue WHERE status = 'dead'),
    'source_queue', (SELECT count(*) FROM public.source_scrape_queue WHERE status = 'dead'),
    'oldest_tag_dead_at', (SELECT min(finished_at) FROM public.event_tag_queue WHERE status = 'dead'),
    'oldest_source_dead_at', (SELECT min(finished_at) FROM public.source_scrape_queue WHERE status = 'dead')
  );

  RETURN jsonb_build_object(
    'total_events', v_events->'total',
    'draft_events', v_events->'draft',
    'published_events', v_events->'published',
    'ai_confidence', v_ai,
    'sources', v_sources,
    'dead_letters', v_dead,
    'generated_at', now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_dashboard_stats()
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.admin_dashboard_stats();
$$;

