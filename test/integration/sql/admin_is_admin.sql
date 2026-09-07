-- Source: 20260601000000_schema_baseline.sql (verbatim).
CREATE OR REPLACE FUNCTION "private"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles up
    JOIN public.user_access ua ON ua.user_id = up.id
    WHERE up.id = auth.uid()
      AND up.role = 'admin'
      AND ua.is_enabled = true
      AND (ua.access_expires_at IS NULL OR ua.access_expires_at > now())
  );
$$;
