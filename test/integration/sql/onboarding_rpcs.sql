-- Production rate and redemption functions from the frozen legacy baseline.
CREATE OR REPLACE FUNCTION "private"."is_invite_rate_limited"("p_email_hash" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT count(*) >= 5
  FROM public.invite_redemption_attempts
  WHERE email_hash = p_email_hash
    AND attempted_at > now() - interval '5 minutes'
    AND succeeded = false;
$$;

CREATE OR REPLACE FUNCTION "private"."is_invite_request_rate_limited"("p_email_hash" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT count(*) >= 3
  FROM public.invite_request_attempts
  WHERE email_hash = p_email_hash
    AND attempted_at > now() - interval '10 minutes';
$$;

CREATE OR REPLACE FUNCTION "private"."redeem_invite_for_email"("p_code" "text", "p_email" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_canonical_email text;
  v_email_hash      text;
  v_code_hash       text;
  v_invite_row_id   uuid;
  v_invite_used     int;
  v_invite_max      int;
  v_invite_expires  timestamptz;
  v_invite_revoked  timestamptz;
  v_existing_hash   text;
BEGIN
  v_canonical_email := lower(btrim(coalesce(p_email, '')));

  IF v_canonical_email = '' OR coalesce(btrim(p_code), '') = '' THEN
    RETURN false;
  END IF;

  v_email_hash := encode(extensions.digest(v_canonical_email, 'sha256'), 'hex');
  v_code_hash  := private.hash_invite_code(p_code);

  IF private.is_invite_rate_limited(v_email_hash) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pending_invite_claims
    WHERE email = v_canonical_email
      AND invite_code = v_code_hash
      AND claimed_by IS NULL
      AND expires_at > now()
  ) THEN
    RETURN true;
  END IF;

  SELECT id, used_count, max_uses, expires_at, revoked_at
    INTO v_invite_row_id, v_invite_used, v_invite_max, v_invite_expires, v_invite_revoked
  FROM public.invite_codes
  WHERE code_hash = v_code_hash
  FOR UPDATE;

  IF v_invite_row_id IS NULL
     OR v_invite_revoked IS NOT NULL
     OR v_invite_used >= v_invite_max
     OR (v_invite_expires IS NOT NULL AND v_invite_expires < now()) THEN
    INSERT INTO public.invite_redemption_attempts (email_hash, succeeded)
      VALUES (v_email_hash, false);
    RETURN false;
  END IF;

  SELECT invite_code INTO v_existing_hash
  FROM public.pending_invite_claims
  WHERE email = v_canonical_email
    AND claimed_by IS NULL
    AND expires_at > now()
  LIMIT 1;

  IF v_existing_hash IS NOT NULL AND v_existing_hash <> v_code_hash THEN
    UPDATE public.invite_codes
    SET used_count = GREATEST(used_count - 1, 0)
    WHERE code_hash = v_existing_hash;
  END IF;

  UPDATE public.invite_codes
  SET used_count = used_count + 1
  WHERE id = v_invite_row_id;

  INSERT INTO public.pending_invite_claims (email, invite_code, expires_at, claimed_by, claimed_at, created_at)
  VALUES (v_canonical_email, v_code_hash, now() + interval '2 hours', NULL, NULL, now())
  ON CONFLICT (email) DO UPDATE
    SET invite_code = EXCLUDED.invite_code,
        expires_at  = EXCLUDED.expires_at,
        claimed_by  = NULL,
        claimed_at  = NULL,
        created_at  = now();

  INSERT INTO public.invite_redemption_attempts (email_hash, succeeded)
    VALUES (v_email_hash, true);

  RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.redeem_invite_for_email(p_code text,p_email text) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path TO ''
 AS $$ SELECT private.redeem_invite_for_email(p_code,p_email); $$;
