ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT push_subscriptions_web_unique,
  DROP CONSTRAINT push_subscriptions_mobile_unique,
  ADD CONSTRAINT push_subscriptions_web_unique UNIQUE (user_id, endpoint),
  ADD CONSTRAINT push_subscriptions_mobile_unique UNIQUE (user_id, token);
