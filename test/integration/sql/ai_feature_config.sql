-- Frozen legacy model validation and assignment RPC on the disposable catalog.
CREATE OR REPLACE FUNCTION private.upsert_ai_feature_config(
  p_feature  text,
  p_model_id text,
  p_enabled  bool
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_feature NOT IN (
    'tagging', 'event-review', 'parent-tips',
    'tag-memory', 'review-memory', 'source-auto-reject'
  ) THEN
    RAISE EXCEPTION 'invalid feature: %', p_feature;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.approved_ai_models
    WHERE id = p_model_id
      AND is_enabled = true
  ) THEN
    RAISE EXCEPTION 'model is not approved or enabled: %', p_model_id;
  END IF;

  INSERT INTO public.ai_feature_config (feature, model_id, enabled, updated_at, updated_by)
  VALUES (p_feature, p_model_id, p_enabled, now(), auth.uid())
  ON CONFLICT (feature) DO UPDATE SET
    model_id    = EXCLUDED.model_id,
    enabled     = EXCLUDED.enabled,
    updated_at  = EXCLUDED.updated_at,
    updated_by  = EXCLUDED.updated_by;
END;
$$;
CREATE OR REPLACE FUNCTION public.upsert_ai_feature_config(p_feature text,p_model_id text,p_enabled bool) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private.upsert_ai_feature_config(p_feature,p_model_id,p_enabled); $$;
