-- Private correction-report workflow. Reports are deliberately separate from events:
-- no trigger or function in this migration updates a public listing.
CREATE TYPE public.correction_report_category AS ENUM (
  'cancellation', 'wrong_date_time', 'wrong_location', 'wrong_cost', 'accessibility', 'other'
);
CREATE TYPE public.correction_report_status AS ENUM ('new', 'in_review', 'resolved', 'dismissed');

CREATE TABLE public.correction_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  reporter_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  category public.correction_report_category NOT NULL,
  details text NOT NULL CHECK (char_length(details) BETWEEN 1 AND 2000),
  priority smallint GENERATED ALWAYS AS
    (CASE WHEN category = 'cancellation' THEN 0 WHEN category = 'wrong_date_time' THEN 1 ELSE 2 END) STORED,
  status public.correction_report_status NOT NULL DEFAULT 'new',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  claimed_by uuid NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  claimed_at timestamptz NULL,
  resolved_by uuid NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  resolved_at timestamptz NULL,
  resolution_note text NULL CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 2000),
  correction_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'new' AND claimed_by IS NULL AND claimed_at IS NULL AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_note IS NULL AND correction_id IS NULL)
    OR (status = 'in_review' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_note IS NULL AND correction_id IS NULL)
    OR (status = 'resolved' AND claimed_by IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL AND correction_id IS NOT NULL)
    OR (status = 'dismissed' AND claimed_by IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL AND correction_id IS NULL)
  )
);

CREATE FUNCTION private.valid_correction_evidence_urls(urls text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(urls) <= 5
    AND coalesce(bool_and(url ~ '^https?://' AND char_length(url) <= 2048), true)
  FROM unnest(urls) url
$$;

CREATE TABLE private.correction_report_private (
  report_id uuid PRIMARY KEY REFERENCES public.correction_reports(id) ON DELETE CASCADE,
  contact jsonb NULL CHECK (
    contact IS NULL OR (
      jsonb_typeof(contact) = 'object'
      AND contact - 'email' - 'phone' = '{}'::jsonb
      AND coalesce(char_length(contact->>'email'), 0) <= 320
      AND coalesce(char_length(contact->>'phone'), 0) <= 32
    )
  ),
  evidence text[] NULL CHECK (
    evidence IS NULL OR private.valid_correction_evidence_urls(evidence)
  )
);

-- Explicit attributable listing correction. Creating one does not itself edit an event.
CREATE TABLE public.listing_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  audit_log_id uuid NOT NULL UNIQUE REFERENCES public.admin_audit_log(id) ON DELETE RESTRICT,
  audit_note text NOT NULL CHECK (char_length(audit_note) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.correction_reports
  ADD CONSTRAINT correction_reports_correction_id_fkey
  FOREIGN KEY (correction_id) REFERENCES public.listing_corrections(id) ON DELETE RESTRICT;

-- Anonymous capabilities are random, hashed, expiring and intentionally have no user/report FK.
CREATE TABLE private.correction_report_capabilities (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE private.correction_report_recent_content (
  digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  submission_count smallint NOT NULL DEFAULT 1 CHECK (submission_count BETWEEN 1 AND 5)
);

CREATE TABLE private.correction_reporter_restrictions (
  reporter_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  confirmed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX correction_reports_queue_idx
  ON public.correction_reports (status, priority, created_at, id);
CREATE INDEX correction_reports_owner_idx
  ON public.correction_reports (reporter_user_id, created_at DESC)
  WHERE reporter_user_id IS NOT NULL;
CREATE INDEX correction_reports_event_idx ON public.correction_reports (event_id);
CREATE INDEX correction_reports_claimed_by_idx ON public.correction_reports (claimed_by)
  WHERE claimed_by IS NOT NULL;
CREATE INDEX correction_reports_resolved_by_idx ON public.correction_reports (resolved_by)
  WHERE resolved_by IS NOT NULL;
CREATE INDEX correction_reports_correction_id_idx ON public.correction_reports (correction_id)
  WHERE correction_id IS NOT NULL;
CREATE INDEX listing_corrections_event_idx ON public.listing_corrections (event_id);
CREATE INDEX listing_corrections_operator_idx ON public.listing_corrections (operator_id);
CREATE INDEX correction_report_recent_content_event_idx
  ON private.correction_report_recent_content (event_id);
CREATE INDEX correction_report_capabilities_expiry_idx
  ON private.correction_report_capabilities (expires_at);

ALTER TABLE public.correction_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.correction_reports, public.listing_corrections FROM anon, authenticated;
REVOKE ALL ON private.correction_report_private FROM anon, authenticated;
REVOKE ALL ON private.correction_report_capabilities, private.correction_report_recent_content,
  private.correction_reporter_restrictions FROM anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.correction_reports, public.listing_corrections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.correction_report_private,
  private.correction_report_capabilities, private.correction_report_recent_content,
  private.correction_reporter_restrictions TO service_role;

COMMENT ON TABLE private.correction_report_private IS
  'Private operator-only report material. Retain only while needed for review; delete with the report.';
COMMENT ON TABLE private.correction_report_capabilities IS
  'Short-lived anonymous anti-abuse capabilities. Purge expired rows; never join to reports or people.';

CREATE FUNCTION private.link_listing_correction(
  p_report_id uuid, p_event_id uuid, p_operator_id uuid, p_audit_log_id uuid, p_note text
) RETURNS public.listing_corrections LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private AS $$
DECLARE r public.listing_corrections;
BEGIN
  IF NOT private.is_admin() THEN RAISE EXCEPTION 'CORRECTION_REPORT_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF auth.uid() IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'CORRECTION_REPORT_ACTOR_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(p_note)) NOT BETWEEN 1 AND 2000 OR NOT EXISTS (
    SELECT 1 FROM public.admin_audit_log a
    WHERE a.id = p_audit_log_id
      AND a.target_id::text = p_event_id::text
      AND a.admin_user_id = p_operator_id
      AND a.target_type = 'event'
      AND a.action = 'event.update'
      AND a.created_at > (
        SELECT cr.created_at FROM public.correction_reports cr
        WHERE cr.id = p_report_id AND cr.event_id = p_event_id
      )
      AND jsonb_typeof(a.metadata->'patch') = 'object'
      AND a.metadata->'patch' <> '{}'::jsonb
      AND jsonb_typeof(a.metadata->'changed_fields') = 'array'
      AND jsonb_array_length(a.metadata->'changed_fields') > 0
  ) THEN RAISE EXCEPTION 'CORRECTION_REPORT_COMMITTED_EDIT_REQUIRED' USING ERRCODE = '23514'; END IF;
  INSERT INTO public.listing_corrections(event_id,operator_id,audit_log_id,audit_note)
  VALUES (p_event_id,p_operator_id,p_audit_log_id,btrim(p_note)) RETURNING * INTO r;
  RETURN r;
END $$;

CREATE FUNCTION private.claim_correction_report(p_report_id uuid, p_operator_id uuid, p_version integer)
RETURNS public.correction_reports LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private AS $$
DECLARE r public.correction_reports;
BEGIN
  IF NOT private.is_admin() THEN RAISE EXCEPTION 'CORRECTION_REPORT_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF auth.uid() IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'CORRECTION_REPORT_ACTOR_MISMATCH' USING ERRCODE = '42501';
  END IF;
  UPDATE public.correction_reports
     SET status = 'in_review', claimed_by = p_operator_id, claimed_at = now(),
         version = version + 1, updated_at = now()
   WHERE id = p_report_id AND status = 'new' AND version = p_version
   RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'CORRECTION_REPORT_CONFLICT' USING ERRCODE = '40001'; END IF;
  RETURN r;
END $$;

CREATE FUNCTION private.resolve_correction_report(
  p_report_id uuid, p_operator_id uuid, p_version integer,
  p_outcome public.correction_report_status, p_note text, p_correction_id uuid DEFAULT NULL
) RETURNS public.correction_reports LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private AS $$
DECLARE r public.correction_reports;
BEGIN
  IF NOT private.is_admin() THEN RAISE EXCEPTION 'CORRECTION_REPORT_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF auth.uid() IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'CORRECTION_REPORT_ACTOR_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_outcome NOT IN ('resolved', 'dismissed') OR char_length(btrim(p_note)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'CORRECTION_REPORT_INVALID_RESOLUTION' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'resolved' AND NOT EXISTS (
    SELECT 1
    FROM public.listing_corrections c
    JOIN public.correction_reports x ON x.event_id = c.event_id
    JOIN public.admin_audit_log a ON a.id = c.audit_log_id
    WHERE x.id = p_report_id AND c.id = p_correction_id
      AND a.target_id::text = c.event_id::text AND a.admin_user_id = c.operator_id
      AND a.target_type = 'event' AND a.action = 'event.update'
      AND a.created_at > x.created_at
      AND jsonb_typeof(a.metadata->'patch') = 'object'
      AND a.metadata->'patch' <> '{}'::jsonb
      AND jsonb_typeof(a.metadata->'changed_fields') = 'array'
      AND jsonb_array_length(a.metadata->'changed_fields') > 0
  ) THEN RAISE EXCEPTION 'CORRECTION_REPORT_CORRECTION_REQUIRED' USING ERRCODE = '23514'; END IF;
  IF p_outcome = 'dismissed' AND p_correction_id IS NOT NULL THEN
    RAISE EXCEPTION 'CORRECTION_REPORT_DISMISSAL_HAS_CORRECTION' USING ERRCODE = '23514';
  END IF;
  UPDATE public.correction_reports
     SET status = p_outcome, resolved_by = p_operator_id, resolved_at = now(),
         resolution_note = btrim(p_note), correction_id = p_correction_id,
         version = version + 1, updated_at = now()
   WHERE id = p_report_id AND status = 'in_review' AND claimed_by = p_operator_id AND version = p_version
   RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'CORRECTION_REPORT_CONFLICT' USING ERRCODE = '40001'; END IF;
  DELETE FROM private.correction_report_private WHERE report_id = p_report_id;
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION private.claim_correction_report(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.link_listing_correction(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.resolve_correction_report(uuid, uuid, integer, public.correction_report_status, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.valid_correction_evidence_urls(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.valid_correction_evidence_urls(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION private.claim_correction_report(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION private.link_listing_correction(uuid, uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION private.resolve_correction_report(uuid, uuid, integer, public.correction_report_status, text, uuid) TO service_role;

