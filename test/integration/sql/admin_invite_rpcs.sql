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
