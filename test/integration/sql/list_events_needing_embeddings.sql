-- list_events_needing_embeddings RPC, extracted VERBATIM from
-- family-events-backend 20260610190000_list_events_needing_embeddings_rpc.sql
-- lines 6-19 (U29, Task 2). Latest-wins check: this is the only CREATE OR
-- REPLACE of this function across the legacy migrations. REVOKE/GRANT
-- statements omitted: the bare test database has no anon/authenticated/
-- service_role roles.
--
-- LEFT JOINs public.event_embeddings, so this fixture must be applied AFTER
-- test/integration/sql/event_embeddings_similarity.sql (which creates that
-- table + the pgvector extension) rather than folded into the base
-- ensureIngestionSchema.

CREATE OR REPLACE FUNCTION public.list_events_needing_embeddings(p_limit int DEFAULT 50)
RETURNS TABLE (id uuid, title text, description text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT e.id, e.title, e.description
  FROM public.events e
  LEFT JOIN public.event_embeddings ee ON ee.event_id = e.id
  WHERE ee.event_id IS NULL
  ORDER BY e.created_at ASC
  LIMIT GREATEST(1, LEAST(p_limit, 500));
$$;
