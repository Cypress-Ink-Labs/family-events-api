ALTER TABLE private.transactional_email_outbox
  DROP CONSTRAINT transactional_email_outbox_kind_check,
  ADD CONSTRAINT transactional_email_outbox_kind_check CHECK(kind IN (
    'welcome','admin_request','request_approved','request_rejected',
    'community_event_approved','community_event_rejected'
  ));

CREATE OR REPLACE FUNCTION private.notify_community_event_status()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_email text;
  v_name text;
  v_kind text;
  v_delivery_id uuid;
BEGIN
  IF NEW.submitted_by IS NULL OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF EXISTS(SELECT FROM private.clerk_user_lifecycle WHERE storage_uuid=NEW.submitted_by AND deleted_at IS NOT NULL)
    OR EXISTS(SELECT FROM private.account_deletions WHERE user_id=NEW.submitted_by) THEN
    RETURN NEW;
  END IF;
  IF NEW.status::text = 'published' THEN
    v_kind := 'community_event_approved';
  ELSIF NEW.status::text = 'rejected' THEN
    v_kind := 'community_event_rejected';
  ELSE
    RETURN NEW;
  END IF;

  SELECT au.email,COALESCE(up.display_name,split_part(au.email,'@',1))
    INTO v_email,v_name
    FROM auth.users au LEFT JOIN public.user_profiles up ON up.id=au.id
    WHERE au.id=NEW.submitted_by;
  IF v_email IS NULL THEN RETURN NEW; END IF;

  v_delivery_id := gen_random_uuid();
  INSERT INTO private.transactional_email_outbox(id,dedupe_key,kind,target_id,payload)
  VALUES(v_delivery_id,v_kind||':'||NEW.id::text||':'||v_delivery_id::text,v_kind,NEW.submitted_by,
    jsonb_build_object('email',v_email,'username',v_name,'event_title',NEW.title,'event_id',NEW.id::text));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_community_event_status ON public.events;
CREATE TRIGGER trg_notify_community_event_status AFTER UPDATE OF status ON public.events
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION private.notify_community_event_status();

CREATE FUNCTION private.cancel_deleted_community_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  UPDATE private.transactional_email_outbox
    SET status='cancelled',payload=NULL,delivery=NULL,locked_until=NULL,
      last_error='account_deleted',updated_at=now()
    WHERE target_id=OLD.id AND kind IN ('community_event_approved','community_event_rejected')
      AND status<>'sent';
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION private.cancel_deleted_community_email() FROM PUBLIC;
CREATE TRIGGER cancel_deleted_community_email AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.cancel_deleted_community_email();
