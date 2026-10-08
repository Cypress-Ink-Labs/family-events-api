DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.push_subscriptions GROUP BY user_id, endpoint HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM public.push_subscriptions GROUP BY user_id, token HAVING count(*) > 1)
  THEN
    RAISE EXCEPTION 'Push subscription rollback blocked: multiple devices cannot fit the legacy uniqueness rules. Preserve subscriptions and review rollback before proceeding.';
  END IF;
END;
$$;

ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT push_subscriptions_web_unique,
  DROP CONSTRAINT push_subscriptions_mobile_unique,
  ADD CONSTRAINT push_subscriptions_web_unique UNIQUE NULLS NOT DISTINCT (user_id, endpoint),
  ADD CONSTRAINT push_subscriptions_mobile_unique UNIQUE NULLS NOT DISTINCT (user_id, token);
