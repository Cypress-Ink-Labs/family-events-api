LOCK TABLE public.ai_feature_config IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO public.approved_ai_models (id, provider, display_name, description, cost_tier)
VALUES
  ('openai/gpt-6-luna', 'gateway', 'GPT-6 Luna',
   'Default. Efficient OpenAI reasoning model through the Vercel AI Gateway.', 'low'),
  ('openai/gpt-6-luna-fast', 'gateway', 'GPT-6 Luna (fast)',
   'Faster GPT-6 Luna through the Vercel AI Gateway at twice the token price.', 'low');

UPDATE public.approved_ai_models
SET description = 'Fast non-reasoning Grok through the Vercel AI Gateway.'
WHERE id = 'spacexai/grok-4.20-non-reasoning'
  AND description = 'Default. Fast non-reasoning Grok through the Vercel AI Gateway.';

CREATE TABLE private.api_ai_gateway_luna_rollback (
  feature text PRIMARY KEY,
  model_id text NOT NULL
);
ALTER TABLE private.api_ai_gateway_luna_rollback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.api_ai_gateway_luna_rollback FROM PUBLIC, anon, authenticated;

INSERT INTO private.api_ai_gateway_luna_rollback (feature, model_id)
SELECT feature, model_id FROM public.ai_feature_config;

UPDATE public.ai_feature_config cfg
SET model_id = 'openai/gpt-6-luna', updated_at = now()
FROM private.api_ai_gateway_luna_rollback backup
WHERE backup.feature = cfg.feature;
