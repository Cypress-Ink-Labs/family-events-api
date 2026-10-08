CREATE TABLE private.clerk_user_lifecycle (
  clerk_user_id text PRIMARY KEY CHECK (clerk_user_id ~ '^user_'),
  storage_uuid uuid,
  provider_updated_at bigint NOT NULL DEFAULT 0 CHECK (provider_updated_at >= 0),
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clerk_user_lifecycle_deleted_storage_uuid_idx ON private.clerk_user_lifecycle(storage_uuid) WHERE deleted_at IS NOT NULL;
ALTER TABLE private.clerk_user_lifecycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.clerk_user_lifecycle FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.clerk_user_lifecycle TO service_role;

CREATE FUNCTION private.tombstone_deleted_clerk_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  INSERT INTO private.clerk_user_lifecycle (clerk_user_id, storage_uuid, deleted_at)
  SELECT clerk_user_id, OLD.id, now() FROM public.clerk_user_mapping WHERE supabase_uuid = OLD.id
  ON CONFLICT (clerk_user_id) DO UPDATE SET
    deleted_at = coalesce(private.clerk_user_lifecycle.deleted_at, excluded.deleted_at),
    storage_uuid = excluded.storage_uuid, updated_at = now();
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION private.tombstone_deleted_clerk_user() FROM PUBLIC;
CREATE TRIGGER tombstone_deleted_clerk_user BEFORE DELETE ON auth.users
FOR EACH ROW EXECUTE FUNCTION private.tombstone_deleted_clerk_user();

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  invite_required boolean;
  v_username      text;
BEGIN
  invite_required := private.invites_required();

  v_username := coalesce(
    NEW.raw_user_meta_data->>'display_name',
    split_part(NEW.email, '@', 1)
  );

  INSERT INTO public.user_profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, v_username)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_access (
    user_id, is_enabled, enabled_at, disabled_at, disabled_reason, created_at, updated_at
  )
  VALUES (
    NEW.id,
    NOT invite_required,
    CASE WHEN invite_required THEN NULL ELSE now() END,
    NULL, NULL, now(), now()
  )
  ON CONFLICT (user_id) DO NOTHING;

  IF NEW.raw_app_meta_data->>'provider' IS DISTINCT FROM 'clerk' THEN
  BEGIN
    PERFORM private.dispatch_email_notification(jsonb_build_object(
      'kind',     'welcome',
      'email',    NEW.email,
      'username', v_username
    ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to dispatch welcome email for %: %', NEW.email, SQLERRM;
  END;
  END IF;

  RETURN NEW;
END;
$$;
