-- Production definitions copied from family-events-backend:
-- admin_set_user_access from 20260601003000_maintenance_and_admin_queues.sql;
-- admin_delete_user from 20260601036000_admin_user_delete.sql.

CREATE OR REPLACE FUNCTION private.admin_set_user_access(
  p_user_id uuid,
  p_is_enabled boolean,
  p_disabled_reason text DEFAULT NULL
) RETURNS public.user_access
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  before_row public.user_access%ROWTYPE;
  updated_row public.user_access%ROWTYPE;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_USER_ACCESS_ADMIN_REQUIRED';
  END IF;

  IF p_user_id = auth.uid() AND NOT p_is_enabled THEN
    RAISE EXCEPTION 'ADMIN_USER_ACCESS_SELF_DISABLE';
  END IF;

  SELECT *
    INTO before_row
    FROM public.user_access
   WHERE user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMIN_USER_ACCESS_NOT_FOUND';
  END IF;

  UPDATE public.user_access
     SET is_enabled = p_is_enabled,
         enabled_at = CASE
           WHEN p_is_enabled THEN COALESCE(public.user_access.enabled_at, now())
           ELSE public.user_access.enabled_at
         END,
         disabled_at = CASE WHEN p_is_enabled THEN NULL ELSE now() END,
         disabled_reason = CASE
           WHEN p_is_enabled THEN NULL
           ELSE NULLIF(btrim(COALESCE(p_disabled_reason, '')), '')
         END,
         updated_at = now()
   WHERE user_id = p_user_id
   RETURNING * INTO updated_row;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    CASE WHEN p_is_enabled THEN 'user_access.enable' ELSE 'user_access.disable' END,
    'user_access',
    p_user_id,
    jsonb_build_object(
      'previous', to_jsonb(before_row),
      'is_enabled', p_is_enabled,
      'disabled_reason', updated_row.disabled_reason
    )
  );

  RETURN updated_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_user_access(
  p_user_id uuid,
  p_is_enabled boolean,
  p_disabled_reason text DEFAULT NULL
) RETURNS public.user_access
LANGUAGE sql
SET search_path TO ''
AS $$
  SELECT * FROM private.admin_set_user_access(p_user_id, p_is_enabled, p_disabled_reason);
$$;

CREATE OR REPLACE FUNCTION private.admin_delete_user(
  p_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  before_access  public.user_access%ROWTYPE;
  before_profile public.user_profiles%ROWTYPE;
  target_role    text;
  affected       integer;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_USER_ACCESS_ADMIN_REQUIRED';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'ADMIN_USER_ACCESS_SELF_DELETE';
  END IF;

  SELECT * INTO before_access FROM public.user_access WHERE user_id = p_user_id;
  SELECT * INTO before_profile FROM public.user_profiles WHERE id = p_user_id;
  SELECT role INTO target_role FROM public.user_profiles WHERE id = p_user_id;

  IF target_role = 'admin' THEN
    RAISE EXCEPTION 'ADMIN_USER_ACCESS_CANNOT_DELETE_ADMIN';
  END IF;

  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS affected = ROW_COUNT;

  IF affected = 0 THEN
    RAISE EXCEPTION 'ADMIN_USER_ACCESS_NOT_FOUND';
  END IF;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'user.delete',
    'user_access',
    p_user_id,
    jsonb_build_object(
      'previous_access', to_jsonb(before_access),
      'previous_profile', to_jsonb(before_profile)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_user(
  p_user_id uuid
) RETURNS void
LANGUAGE sql
SET search_path TO ''
AS $$
  SELECT private.admin_delete_user(p_user_id);
$$;
