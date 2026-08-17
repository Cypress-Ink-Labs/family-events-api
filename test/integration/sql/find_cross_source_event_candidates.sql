-- Extracted VERBATIM from family-events-backend migration
-- 20260620010000_find_cross_source_event_candidates.sql (U28).
-- GRANT/REVOKE statements stripped: the bare test database has no service_role.

CREATE OR REPLACE FUNCTION public.find_cross_source_event_candidates(
  p_city_id   uuid,
  p_start_from timestamptz,
  p_start_to   timestamptz,
  p_limit      integer DEFAULT 500
)
RETURNS TABLE (
  id             uuid,
  title          text,
  source_id      uuid,
  start_datetime timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT
    e.id,
    e.title,
    e.source_id,
    e.start_datetime
  FROM public.events e
  WHERE e.city_id = p_city_id
    AND e.start_datetime BETWEEN p_start_from AND p_start_to
    AND e.status <> 'rejected'::public.event_status
  ORDER BY e.start_datetime
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
$$;
