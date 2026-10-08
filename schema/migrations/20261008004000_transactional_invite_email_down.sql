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
DROP TABLE private.transactional_email_outbox;
