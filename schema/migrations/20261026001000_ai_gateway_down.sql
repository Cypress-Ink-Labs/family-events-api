DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM public.events WHERE ai_tag_provider = 'gateway')
    OR EXISTS (SELECT 1 FROM public.event_ai_traces WHERE provider = 'gateway') THEN
    RAISE EXCEPTION 'ai gateway rollback blocked: gateway-tagged events or traces exist';
  END IF;
END;
$rollback$;

DROP TABLE private.ai_call_health;

UPDATE public.ai_feature_config cfg
SET model_id = backup.model_id, updated_at = now()
FROM private.api_ai_gateway_rollback backup
JOIN public.approved_ai_models models ON models.id = backup.model_id
WHERE backup.feature = cfg.feature;

DO $rollback$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ai_feature_config cfg
    JOIN public.approved_ai_models models ON models.id = cfg.model_id
    WHERE models.provider = 'gateway'
  ) THEN
    RAISE EXCEPTION 'ai gateway rollback blocked: a feature uses a gateway model with no saved assignment';
  END IF;
END;
$rollback$;

DROP TABLE private.api_ai_gateway_rollback;
DELETE FROM public.approved_ai_models WHERE provider = 'gateway';

ALTER TABLE public.event_ai_traces DROP CONSTRAINT event_ai_traces_provider_check;
ALTER TABLE public.event_ai_traces ADD CONSTRAINT event_ai_traces_provider_check
  CHECK (provider IS NULL OR provider = ANY (ARRAY['openai'::text, 'ollama'::text, 'localai'::text]));

ALTER TABLE public.events DROP CONSTRAINT events_ai_tag_provider_check;
ALTER TABLE public.events ADD CONSTRAINT events_ai_tag_provider_check
  CHECK (ai_tag_provider IS NULL OR ai_tag_provider = ANY (ARRAY['openai'::text, 'ollama'::text, 'localai'::text]));

ALTER TABLE public.approved_ai_models DROP CONSTRAINT approved_ai_models_provider_check;
ALTER TABLE public.approved_ai_models ADD CONSTRAINT approved_ai_models_provider_check
  CHECK (provider IN ('openai', 'ollama', 'localai'));
