CREATE TABLE private.account_deletions (
 user_id uuid PRIMARY KEY,
 clerk_user_id text UNIQUE CHECK(clerk_user_id ~ '^user_'),
 status text NOT NULL CHECK(status IN ('pending_provider','pending_cleanup','cleanup_deferred','completed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 locked_until timestamptz,
 requested_at timestamptz NOT NULL DEFAULT now(),
 provider_confirmed_at timestamptz,
 completed_at timestamptz,
 last_error text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.account_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.account_deletions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.account_deletions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON private.account_deletions TO service_role;
CREATE POLICY account_deletions_service_only ON private.account_deletions TO service_role USING(true) WITH CHECK(true);

CREATE OR REPLACE FUNCTION private.reject_deleted_user_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
 IF NEW.is_enabled AND (
  EXISTS(SELECT FROM private.account_deletions WHERE user_id=NEW.user_id)
  OR EXISTS(SELECT FROM private.clerk_user_lifecycle WHERE storage_uuid=NEW.user_id AND deleted_at IS NOT NULL)
 ) THEN
  RAISE EXCEPTION 'ADMIN_USER_ACCESS_DELETED_ACCOUNT';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.reject_deleted_user_access() FROM PUBLIC;
CREATE TRIGGER reject_deleted_user_access BEFORE INSERT OR UPDATE ON public.user_access
FOR EACH ROW EXECUTE FUNCTION private.reject_deleted_user_access();
