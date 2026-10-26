ALTER TABLE public.approved_ai_models DROP CONSTRAINT approved_ai_models_provider_check;
ALTER TABLE public.approved_ai_models ADD CONSTRAINT approved_ai_models_provider_check
  CHECK (provider IN ('gateway', 'openai', 'ollama', 'localai'));

ALTER TABLE public.events DROP CONSTRAINT events_ai_tag_provider_check;
ALTER TABLE public.events ADD CONSTRAINT events_ai_tag_provider_check
  CHECK (ai_tag_provider IS NULL OR ai_tag_provider IN ('gateway', 'openai', 'ollama', 'localai'));

ALTER TABLE public.event_ai_traces DROP CONSTRAINT event_ai_traces_provider_check;
ALTER TABLE public.event_ai_traces ADD CONSTRAINT event_ai_traces_provider_check
  CHECK (provider IS NULL OR provider IN ('gateway', 'openai', 'ollama', 'localai'));

INSERT INTO public.approved_ai_models (id, provider, display_name, description, cost_tier)
VALUES
  ('spacexai/grok-4.20-non-reasoning', 'gateway', 'Grok 4.20 (fast)',
   'Default. Fast non-reasoning Grok through the Vercel AI Gateway.', 'low'),
  ('spacexai/grok-4.3', 'gateway', 'Grok 4.3',
   'Reasoning Grok through the Vercel AI Gateway for harder review calls.', 'medium'),
  ('spacexai/grok-4.7', 'gateway', 'Grok 4.7',
   'Latest Grok through the Vercel AI Gateway. Higher token cost.', 'medium');

CREATE TABLE private.api_ai_gateway_rollback (
  feature text PRIMARY KEY,
  model_id text NOT NULL
);
ALTER TABLE private.api_ai_gateway_rollback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.api_ai_gateway_rollback FROM PUBLIC, anon, authenticated;

INSERT INTO private.api_ai_gateway_rollback (feature, model_id)
SELECT cfg.feature, cfg.model_id
FROM public.ai_feature_config cfg
JOIN public.approved_ai_models models ON models.id = cfg.model_id
WHERE models.provider = 'openai';

UPDATE public.ai_feature_config cfg
SET model_id = 'spacexai/grok-4.20-non-reasoning', updated_at = now()
FROM private.api_ai_gateway_rollback backup
WHERE backup.feature = cfg.feature;

CREATE TABLE private.ai_call_health (
  feature text PRIMARY KEY
    CHECK (feature IN ('tagging', 'event-review', 'parent-tips', 'embeddings', 'source-extraction')),
  provider text NOT NULL,
  model text NOT NULL,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_reason text
    CHECK (last_failure_reason IN ('unauthorized', 'rate_limited', 'timeout', 'provider_error')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.ai_call_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.ai_call_health FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.ai_call_health TO service_role;
