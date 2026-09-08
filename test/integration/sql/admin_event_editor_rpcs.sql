-- Production definitions copied from family-events-backend:
-- private.admin_validate_event_patch/private.admin_unlock_event_fields and the
-- public unlock wrapper from 20260601000000_schema_baseline.sql;
-- private/public admin_update_event from 20260601021000_admin_event_decisions.sql.

CREATE OR REPLACE FUNCTION private.admin_validate_event_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path TO ''
AS $$
DECLARE
  allowed_fields constant text[] := ARRAY[
    'title',
    'description',
    'start_datetime',
    'end_datetime',
    'timezone',
    'venue_name',
    'address',
    'city_id',
    'latitude',
    'longitude',
    'age_min',
    'age_max',
    'price',
    'is_free',
    'is_outdoor',
    'source_url',
    'source_name',
    'source_id',
    'images',
    'status',
    'recurrence_info',
    'is_featured'
  ];
  system_fields constant text[] := ARRAY[
    'id',
    'created_at',
    'updated_at',
    'view_count',
    'search_vector',
    'ai_confidence',
    'ai_tag_provider',
    'admin_locked_fields',
    'admin_last_edited_at',
    'admin_last_edited_by'
  ];
  key text;
BEGIN
  IF p_patch IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  IF jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'ADMIN_EVENT_UNKNOWN_FIELD';
  END IF;

  FOR key IN SELECT jsonb_object_keys(p_patch)
  LOOP
    IF key = ANY(system_fields) THEN
      RAISE EXCEPTION 'ADMIN_EVENT_SYSTEM_FIELD';
    END IF;
    IF NOT key = ANY(allowed_fields) THEN
      RAISE EXCEPTION 'ADMIN_EVENT_UNKNOWN_FIELD';
    END IF;
  END LOOP;

  IF p_patch ? 'images' THEN
    IF jsonb_typeof(p_patch->'images') <> 'array' THEN
      RAISE EXCEPTION 'ADMIN_EVENT_UNKNOWN_FIELD';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_patch->'images') image_item
      WHERE jsonb_typeof(image_item) <> 'string'
    ) THEN
      RAISE EXCEPTION 'ADMIN_EVENT_UNKNOWN_FIELD';
    END IF;
  END IF;

  IF p_patch ? 'status'
     AND (p_patch->>'status') NOT IN ('draft', 'published', 'rejected', 'archived') THEN
    RAISE EXCEPTION 'ADMIN_EVENT_INVALID_STATUS';
  END IF;

  RETURN p_patch;
END;
$$;

CREATE OR REPLACE FUNCTION private.admin_unlock_event_fields(p_event_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_EVENT_ADMIN_REQUIRED';
  END IF;

  UPDATE public.events
     SET admin_locked_fields = '{}',
         admin_last_edited_at = now(),
         admin_last_edited_by = auth.uid(),
         updated_at = now()
   WHERE id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMIN_EVENT_NOT_FOUND';
  END IF;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'event.fields.unlock',
    'event',
    p_event_id,
    jsonb_build_object('locked_fields_after', '[]'::jsonb)
  );

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unlock_event_fields(p_event_id uuid)
RETURNS boolean
LANGUAGE sql
SET search_path TO ''
AS $$
  SELECT private.admin_unlock_event_fields(p_event_id);
$$;

CREATE OR REPLACE FUNCTION private.admin_update_event(
  p_event_id uuid,
  p_patch jsonb,
  p_tag_ids uuid[],
  p_lock_edited_fields boolean DEFAULT true,
  p_decision_reason text DEFAULT NULL
)
RETURNS public.events
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  patch jsonb;
  before_row public.events%ROWTYPE;
  updated_row public.events%ROWTYPE;
  changed_fields text[];
  previous_tag_ids uuid[];
  next_tag_ids uuid[];
  next_locked_fields text[];
  next_title text;
  next_start timestamptz;
  next_end timestamptz;
  next_age_min integer;
  next_age_max integer;
  next_price numeric;
  v_status_changed boolean := false;
  v_tags_changed boolean := false;
  v_decision_type text;
  v_old_tags jsonb;
  v_new_tags jsonb;
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_EVENT_ADMIN_REQUIRED';
  END IF;

  patch := private.admin_validate_event_patch(COALESCE(p_patch, '{}'::jsonb));
  SELECT * INTO before_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADMIN_EVENT_NOT_FOUND';
  END IF;

  changed_fields := ARRAY(SELECT jsonb_object_keys(patch));
  next_title := CASE WHEN patch ? 'title' THEN NULLIF(btrim(patch->>'title'), '') ELSE before_row.title END;
  next_start := CASE
    WHEN patch ? 'start_datetime' AND jsonb_typeof(patch->'start_datetime') = 'null' THEN NULL
    WHEN patch ? 'start_datetime' THEN (patch->>'start_datetime')::timestamptz
    ELSE before_row.start_datetime
  END;
  next_end := CASE
    WHEN patch ? 'end_datetime' AND jsonb_typeof(patch->'end_datetime') = 'null' THEN NULL
    WHEN patch ? 'end_datetime' THEN (patch->>'end_datetime')::timestamptz
    ELSE before_row.end_datetime
  END;
  next_age_min := CASE
    WHEN patch ? 'age_min' AND jsonb_typeof(patch->'age_min') = 'null' THEN NULL
    WHEN patch ? 'age_min' THEN (patch->>'age_min')::integer
    ELSE before_row.age_min
  END;
  next_age_max := CASE
    WHEN patch ? 'age_max' AND jsonb_typeof(patch->'age_max') = 'null' THEN NULL
    WHEN patch ? 'age_max' THEN (patch->>'age_max')::integer
    ELSE before_row.age_max
  END;
  next_price := CASE
    WHEN patch ? 'price' AND jsonb_typeof(patch->'price') = 'null' THEN NULL
    WHEN patch ? 'price' THEN (patch->>'price')::numeric
    ELSE before_row.price
  END;

  IF next_title IS NULL THEN
    RAISE EXCEPTION 'ADMIN_EVENT_TITLE_REQUIRED';
  END IF;
  IF next_start IS NULL THEN
    RAISE EXCEPTION 'ADMIN_EVENT_TITLE_REQUIRED';
  END IF;
  IF next_end IS NOT NULL AND next_end <= next_start THEN
    RAISE EXCEPTION 'ADMIN_EVENT_END_BEFORE_START';
  END IF;
  IF next_age_min IS NOT NULL AND next_age_max IS NOT NULL AND next_age_min > next_age_max THEN
    RAISE EXCEPTION 'ADMIN_EVENT_INVALID_AGE_RANGE';
  END IF;
  IF next_price IS NOT NULL AND next_price < 0 THEN
    RAISE EXCEPTION 'ADMIN_EVENT_INVALID_PRICE';
  END IF;

  next_locked_fields := CASE
    WHEN p_lock_edited_fields THEN ARRAY(
      SELECT DISTINCT field
      FROM unnest(COALESCE(before_row.admin_locked_fields, '{}'::text[]) || changed_fields) field
      ORDER BY field
    )
    ELSE before_row.admin_locked_fields
  END;

  SELECT COALESCE(array_agg(et.tag_id ORDER BY et.tag_id), '{}'::uuid[])
    INTO previous_tag_ids
  FROM public.event_tags et
  WHERE et.event_id = p_event_id;

  next_tag_ids := ARRAY(SELECT DISTINCT tag_id FROM unnest(COALESCE(p_tag_ids, '{}'::uuid[])) tag_id ORDER BY tag_id);

  UPDATE public.events
     SET title = next_title,
         description = CASE WHEN patch ? 'description' AND jsonb_typeof(patch->'description') = 'null' THEN NULL WHEN patch ? 'description' THEN patch->>'description' ELSE description END,
         start_datetime = next_start,
         end_datetime = next_end,
         timezone = CASE WHEN patch ? 'timezone' THEN NULLIF(btrim(patch->>'timezone'), '') ELSE timezone END,
         venue_name = CASE WHEN patch ? 'venue_name' AND jsonb_typeof(patch->'venue_name') = 'null' THEN NULL WHEN patch ? 'venue_name' THEN patch->>'venue_name' ELSE venue_name END,
         address = CASE WHEN patch ? 'address' AND jsonb_typeof(patch->'address') = 'null' THEN NULL WHEN patch ? 'address' THEN patch->>'address' ELSE address END,
         city_id = CASE WHEN patch ? 'city_id' AND jsonb_typeof(patch->'city_id') = 'null' THEN NULL WHEN patch ? 'city_id' THEN (patch->>'city_id')::uuid ELSE city_id END,
         latitude = CASE WHEN patch ? 'latitude' AND jsonb_typeof(patch->'latitude') = 'null' THEN NULL WHEN patch ? 'latitude' THEN (patch->>'latitude')::numeric ELSE latitude END,
         longitude = CASE WHEN patch ? 'longitude' AND jsonb_typeof(patch->'longitude') = 'null' THEN NULL WHEN patch ? 'longitude' THEN (patch->>'longitude')::numeric ELSE longitude END,
         age_min = next_age_min,
         age_max = next_age_max,
         price = next_price,
         is_free = CASE WHEN patch ? 'is_free' THEN (patch->>'is_free')::boolean ELSE is_free END,
         is_outdoor = CASE WHEN patch ? 'is_outdoor' AND jsonb_typeof(patch->'is_outdoor') = 'null' THEN NULL WHEN patch ? 'is_outdoor' THEN (patch->>'is_outdoor')::boolean ELSE is_outdoor END,
         source_url = CASE WHEN patch ? 'source_url' AND jsonb_typeof(patch->'source_url') = 'null' THEN NULL WHEN patch ? 'source_url' THEN patch->>'source_url' ELSE source_url END,
         source_name = CASE WHEN patch ? 'source_name' AND jsonb_typeof(patch->'source_name') = 'null' THEN NULL WHEN patch ? 'source_name' THEN patch->>'source_name' ELSE source_name END,
         source_id = CASE WHEN patch ? 'source_id' AND jsonb_typeof(patch->'source_id') = 'null' THEN NULL WHEN patch ? 'source_id' THEN (patch->>'source_id')::uuid ELSE source_id END,
         images = CASE WHEN patch ? 'images' THEN patch->'images' ELSE images END,
         status = CASE WHEN patch ? 'status' THEN (patch->>'status')::public.event_status ELSE status END,
         recurrence_info = CASE WHEN patch ? 'recurrence_info' THEN patch->'recurrence_info' ELSE recurrence_info END,
         is_featured = CASE WHEN patch ? 'is_featured' THEN (patch->>'is_featured')::boolean ELSE is_featured END,
         admin_locked_fields = next_locked_fields,
         admin_last_edited_at = now(),
         admin_last_edited_by = auth.uid(),
         updated_at = now()
   WHERE id = p_event_id
   RETURNING * INTO updated_row;

  DELETE FROM public.event_tags WHERE event_id = p_event_id;
  INSERT INTO public.event_tags (event_id, tag_id, confidence, is_manual_override)
  SELECT p_event_id, tag_id, 1, true
  FROM unnest(next_tag_ids) tag_id;

  -- Detect what changed for admin_event_decisions
  v_status_changed := (before_row.status IS DISTINCT FROM updated_row.status);
  v_tags_changed := (previous_tag_ids IS DISTINCT FROM next_tag_ids);

  IF v_status_changed OR v_tags_changed THEN
    -- Build tag snapshots with slugs for human-readable context
    SELECT COALESCE(jsonb_agg(jsonb_build_object('tag_id', t.id, 'slug', t.slug, 'name', t.name) ORDER BY t.slug), '[]'::jsonb)
      INTO v_old_tags
    FROM public.tags t
    WHERE t.id = ANY(previous_tag_ids);

    SELECT COALESCE(jsonb_agg(jsonb_build_object('tag_id', t.id, 'slug', t.slug, 'name', t.name) ORDER BY t.slug), '[]'::jsonb)
      INTO v_new_tags
    FROM public.tags t
    WHERE t.id = ANY(next_tag_ids);

    v_decision_type := CASE
      WHEN v_status_changed AND v_tags_changed THEN 'status_and_tags'
      WHEN v_status_changed THEN 'status_change'
      ELSE 'tag_edit'
    END;

    INSERT INTO public.admin_event_decisions (
      event_id, admin_user_id, decision_type,
      old_status, new_status, old_tags, new_tags,
      reason, source_context
    ) VALUES (
      p_event_id,
      auth.uid(),
      v_decision_type,
      before_row.status,
      updated_row.status,
      v_old_tags,
      v_new_tags,
      NULLIF(btrim(COALESCE(p_decision_reason, '')), ''),
      jsonb_build_object('source_id', before_row.source_id, 'source_name', before_row.source_name)
    );
  END IF;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'event.update',
    'event',
    p_event_id,
    jsonb_build_object(
      'previous', to_jsonb(before_row),
      'patch', patch,
      'changed_fields', to_jsonb(changed_fields),
      'previous_tag_ids', to_jsonb(previous_tag_ids),
      'new_tag_ids', to_jsonb(next_tag_ids),
      'locked_fields_after', to_jsonb(next_locked_fields)
    )
  );

  RETURN updated_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_event(
  p_event_id uuid,
  p_patch jsonb,
  p_tag_ids uuid[],
  p_lock_edited_fields boolean DEFAULT true,
  p_decision_reason text DEFAULT NULL
)
RETURNS public.events
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $$
  SELECT * FROM private.admin_update_event(
    p_event_id, p_patch, p_tag_ids, p_lock_edited_fields, p_decision_reason
  );
$$;
