-- One statement, so the lock, guard and restore commit or fail together even
-- when run outside an explicit transaction.
DO $rollback$
BEGIN
  LOCK TABLE public.ai_feature_config IN SHARE ROW EXCLUSIVE MODE;

  UPDATE public.ai_feature_config cfg
  SET model_id = backup.model_id, updated_at = now()
  FROM private.api_ai_gateway_luna_rollback backup
  JOIN public.approved_ai_models models ON models.id = backup.model_id
  WHERE backup.feature = cfg.feature
    AND cfg.model_id = 'openai/gpt-6-luna';

  IF EXISTS (
    SELECT 1 FROM public.ai_feature_config
    WHERE model_id IN ('openai/gpt-6-luna', 'openai/gpt-6-luna-fast')
  ) THEN
    RAISE EXCEPTION 'gpt-6-luna rollback blocked: a feature uses a GPT-6 Luna model with no saved assignment';
  END IF;

  UPDATE public.approved_ai_models
  SET description = 'Default. Fast non-reasoning Grok through the Vercel AI Gateway.'
  WHERE id = 'spacexai/grok-4.20-non-reasoning'
    AND description = 'Fast non-reasoning Grok through the Vercel AI Gateway.';

  DROP TABLE private.api_ai_gateway_luna_rollback;
  DELETE FROM public.approved_ai_models
  WHERE id IN ('openai/gpt-6-luna', 'openai/gpt-6-luna-fast');
END;
$rollback$;
