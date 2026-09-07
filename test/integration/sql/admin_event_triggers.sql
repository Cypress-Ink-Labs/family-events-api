-- Verbatim latest legacy event trigger functions and trigger definitions.
-- Source: 20260601000000_schema_baseline.sql
CREATE OR REPLACE FUNCTION "public"."update_event_search_vector"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  NEW.search_vector := to_tsvector(
    'pg_catalog.english'::regconfig,
    coalesce(NEW.title, '') || ' ' ||
    coalesce(NEW.description, '') || ' ' ||
    coalesce(NEW.venue_name, '') || ' ' ||
    coalesce(NEW.address, '')
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER "events_search_vector_trigger" BEFORE INSERT OR UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "public"."update_event_search_vector"();

-- Source: 20260601004000_llm_review_and_enrichment.sql (last definition)
CREATE OR REPLACE FUNCTION private.clear_llm_review_on_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('published', 'rejected')
     AND OLD.status = 'draft'
  THEN
    NEW.llm_review_status := 'not_required';
  END IF;

  RETURN NEW;
END;
$$;

-- Source: 20260601017000_event_status_enum_and_validate_checks.sql
CREATE TRIGGER trg_clear_llm_review_on_status_change
  BEFORE UPDATE OF status ON public.events
  FOR EACH ROW EXECUTE FUNCTION private.clear_llm_review_on_status_change();
