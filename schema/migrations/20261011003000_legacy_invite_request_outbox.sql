CREATE OR REPLACE FUNCTION "private"."request_invite"("p_email" "text", "p_message" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_canonical_email text;
  v_email_hash      text;
  v_trimmed_message text;
  v_request_id      uuid;
BEGIN
  v_canonical_email := lower(btrim(coalesce(p_email, '')));
  IF v_canonical_email = '' OR position('@' IN v_canonical_email) = 0 THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('invite-request:' || v_canonical_email, 0));

  v_email_hash := encode(extensions.digest(v_canonical_email, 'sha256'), 'hex');

  IF private.is_invite_request_rate_limited(v_email_hash) THEN
    RETURN false;
  END IF;

  v_trimmed_message := nullif(btrim(coalesce(p_message, '')), '');
  IF v_trimmed_message IS NOT NULL AND length(v_trimmed_message) > 500 THEN
    v_trimmed_message := substring(v_trimmed_message FROM 1 FOR 500);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.invite_requests
    WHERE lower(email) = v_canonical_email AND status = 'pending'
  ) THEN
    UPDATE public.invite_requests
    SET message = coalesce(v_trimmed_message, message)
    WHERE lower(email) = v_canonical_email AND status = 'pending'
    RETURNING id INTO v_request_id;
  ELSE
    INSERT INTO public.invite_requests (email, message)
    VALUES (v_canonical_email, v_trimmed_message)
    RETURNING id INTO v_request_id;
  END IF;

  INSERT INTO public.invite_request_attempts (email_hash, succeeded)
    VALUES (v_email_hash, true);

  INSERT INTO private.transactional_email_outbox(dedupe_key,kind,target_id,payload)
  VALUES('admin_request:' || v_request_id::text,'admin_request',v_request_id,
    jsonb_build_object('email',v_canonical_email,'message',v_trimmed_message))
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN true;
END;
$$;
