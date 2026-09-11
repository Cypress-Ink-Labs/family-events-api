-- Production definitions copied from family-events-backend:
-- invite-code helpers/RPCs from 20260601000000_schema_baseline.sql;
-- latest gate default from 20260601014000_fix_invite_gate_default.sql.

CREATE OR REPLACE FUNCTION private.canonicalize_invite_code(p_code text) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO ''
AS $$
  SELECT upper(regexp_replace(coalesce(p_code, ''), '[\s\-_]', '', 'g'));
$$;

CREATE OR REPLACE FUNCTION private.hash_invite_code(p_code text) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO ''
AS $$
  SELECT encode(extensions.digest(private.canonicalize_invite_code(p_code), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION private.invites_required() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT lower(btrim(coalesce(current_setting('app.settings.require_invite', true), 'false')))
         IN ('true', 't', '1', 'yes');
$$;

CREATE OR REPLACE FUNCTION public.invites_required() RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO ''
AS $$ SELECT private.invites_required(); $$;

CREATE OR REPLACE FUNCTION private.admin_create_invite_code(
  p_max_uses integer DEFAULT 1,
  p_expires_at timestamptz DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS TABLE(id uuid, code text, max_uses integer, expires_at timestamptz, notes text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_code text;
  v_code_hash text;
  v_id uuid;
  v_caller uuid;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_length constant int := 24;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_max_uses IS NULL OR p_max_uses < 1 THEN
    RAISE EXCEPTION 'max_uses must be >= 1' USING ERRCODE = '22023';
  END IF;

  v_code := '';
  FOR pos IN 1..v_length LOOP
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  END LOOP;
  v_code_hash := private.hash_invite_code(v_code);
  v_caller := auth.uid();

  INSERT INTO public.invite_codes (code_hash, max_uses, expires_at, notes, created_by, created_at)
  VALUES (v_code_hash, p_max_uses, p_expires_at, p_notes, v_caller, now())
  RETURNING public.invite_codes.id INTO v_id;

  RETURN QUERY
  SELECT v_id, v_code, p_max_uses, p_expires_at, p_notes, now()::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_invite_code(
  p_max_uses integer DEFAULT 1,
  p_expires_at timestamptz DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS TABLE(id uuid, code text, max_uses integer, expires_at timestamptz, notes text, created_at timestamptz)
LANGUAGE sql
SET search_path TO ''
AS $$ SELECT * FROM private.admin_create_invite_code(p_max_uses, p_expires_at, p_notes); $$;

CREATE OR REPLACE FUNCTION private.admin_revoke_invite_code(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_updated int;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE public.invite_codes
  SET revoked_at = now()
  WHERE id = p_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_revoke_invite_code(p_id uuid) RETURNS boolean
LANGUAGE sql
SET search_path TO ''
AS $$ SELECT private.admin_revoke_invite_code(p_id); $$;

-- Production invite-request RPCs copied from
-- 20260601000000_schema_baseline.sql. The dispatcher below replaces the
-- production pg_net implementation while retaining its failure semantics.
CREATE TABLE IF NOT EXISTS private.test_email_dispatch_failure (enabled boolean NOT NULL);
TRUNCATE private.test_email_dispatch_failure;

CREATE OR REPLACE FUNCTION private.dispatch_email_notification(p_payload jsonb) RETURNS void
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM private.test_email_dispatch_failure WHERE enabled) THEN
    RAISE EXCEPTION 'test email dispatch failure';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.admin_approve_invite_request(p_request_id uuid)
RETURNS TABLE(request_id uuid, code text, invite_code_id uuid, email text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_email text;
  v_code text;
  v_code_hash text;
  v_id uuid;
  v_caller uuid;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_length constant int := 24;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_caller := auth.uid();
  SELECT r.email INTO v_email
  FROM public.invite_requests r
  WHERE r.id = p_request_id AND r.status = 'pending'
  FOR UPDATE;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'request not found or already reviewed' USING ERRCODE = 'P0002';
  END IF;

  v_code := '';
  FOR pos IN 1..v_length LOOP
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  END LOOP;
  v_code_hash := private.hash_invite_code(v_code);

  INSERT INTO public.invite_codes (code_hash, max_uses, expires_at, notes, created_by, created_at)
  VALUES (v_code_hash, 1, NULL, 'Approved invite request: ' || v_email, v_caller, now())
  RETURNING public.invite_codes.id INTO v_id;

  UPDATE public.invite_requests
  SET status = 'approved', invite_code_id = v_id, reviewed_at = now(), reviewed_by = v_caller
  WHERE id = p_request_id;

  BEGIN
    PERFORM private.dispatch_email_notification(jsonb_build_object(
      'kind', 'request_approved', 'email', v_email, 'code', v_code
    ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to dispatch approved invite email: %', SQLERRM;
  END;

  RETURN QUERY SELECT p_request_id, v_code, v_id, v_email, now()::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_approve_invite_request(p_request_id uuid)
RETURNS TABLE(request_id uuid, code text, invite_code_id uuid, email text, created_at timestamptz)
LANGUAGE sql
SET search_path TO ''
AS $$ SELECT * FROM private.admin_approve_invite_request(p_request_id); $$;

CREATE OR REPLACE FUNCTION private.admin_reject_invite_request(
  p_request_id uuid,
  p_notes text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_caller uuid;
  v_notes text;
  v_email text;
  v_rows int;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_caller := auth.uid();
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  IF v_notes IS NOT NULL AND length(v_notes) > 1000 THEN
    v_notes := substring(v_notes FROM 1 FOR 1000);
  END IF;

  SELECT r.email INTO v_email
  FROM public.invite_requests r
  WHERE r.id = p_request_id AND r.status = 'pending'
  FOR UPDATE;
  IF v_email IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.invite_requests
  SET status = 'rejected',
      admin_notes = v_notes,
      reviewed_at = now(),
      reviewed_by = v_caller
  WHERE id = p_request_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;

  BEGIN
    PERFORM private.dispatch_email_notification(jsonb_build_object(
      'kind', 'request_rejected', 'email', v_email
    ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to dispatch rejected invite email: %', SQLERRM;
  END;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reject_invite_request(
  p_request_id uuid,
  p_notes text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
SET search_path TO ''
AS $$ SELECT private.admin_reject_invite_request(p_request_id, p_notes); $$;
