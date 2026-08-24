import { Injectable } from "@nestjs/common"

import { DbService } from "../../db/db.service.js"

import type { ParentTip, ParentTipsCandidate } from "./generate-parent-tips.js"
import type {
  EnrichmentCandidate,
  EnrichmentDb,
  ProviderImageAttributionUpsert,
  UnsplashAttributionBackfillUpsert,
  UnsplashAttributionUpsert,
} from "./process-enrichment-backfill.js"
import type { EmbeddingsBackfillDb } from "./process-embeddings-backfill.js"

// SQL translations of the RPCs/direct queries the legacy backfill-event-enrichment,
// generate-parent-tips, and backfill-embeddings edge functions issued (U29).
// Every RPC-backed method here calls a `public.*` wrapper ported verbatim into
// test/integration/sql/event_enrichment_rpcs.sql / list_events_needing_embeddings.sql
// — see each const's doc comment for the legacy RPC name + parameter order.

// list_events_needing_enrichment and backfill_image_enrichment_in_scope both
// return the exact same 12-column EnrichmentCandidate shape (event_enrichment_rpcs.sql).
// Composing the SELECT list once keeps the camelCase alias mapping from drifting
// between the two call sites.
const ENRICHMENT_CANDIDATE_SELECT = `
  SELECT event_id::text AS "eventId", title, description, venue_name AS "venueName",
         address, city_id::text AS "cityId", source_id::text AS "sourceId",
         source_url AS "sourceUrl", needs_coords AS "needsCoords",
         needs_images AS "needsImages", admin_locked_fields AS "adminLockedFields", tags
`

/** public.list_events_needing_enrichment(p_limit) */
const LIST_EVENTS_NEEDING_ENRICHMENT_SQL = `
  ${ENRICHMENT_CANDIDATE_SELECT}
  FROM public.list_events_needing_enrichment($1::int)
`

/** public.backfill_image_enrichment_in_scope(p_limit) */
const LIST_IMAGE_ENRICHMENT_IN_SCOPE_SQL = `
  ${ENRICHMENT_CANDIDATE_SELECT}
  FROM public.backfill_image_enrichment_in_scope($1::int)
`

// Legacy fetched city context for buildGeocodeQuery via a plain supabase-js
// select (index.ts:127-133), cached per tick by the caller (Task 7's
// withCityContextCache) — not this method.
const GET_CITY_CONTEXT_SQL = `
  SELECT name, state
  FROM public.cities
  WHERE id = $1::uuid
`

/** public.update_event_enrichment(p_event_id, p_latitude, p_longitude, p_images) */
const UPDATE_EVENT_ENRICHMENT_SQL = `
  SELECT public.update_event_enrichment($1::uuid, $2, $3, $4::jsonb)
`

// public.upsert_event_image_attribution_with_enrichment parameter order:
// p_event_id, p_latitude, p_longitude, p_images, p_image_url,
// p_unsplash_photo_id, p_unsplash_photographer_name,
// p_unsplash_photographer_username, p_unsplash_photographer_profile_url,
// p_unsplash_photo_url, p_unsplash_download_location, p_matched_tag.
const UPSERT_UNSPLASH_ATTRIBUTION_WITH_ENRICHMENT_SQL = `
  SELECT public.upsert_event_image_attribution_with_enrichment(
    $1::uuid, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12
  ) AS "attributionId"
`

// Direct upsert into event_image_attributions — legacy did this client-side
// for pexels/pixabay (backfill-event-enrichment/index.ts:355-374), no RPC
// exists. supabase-js `.upsert(payload, { onConflict: "event_id,image_url" })`
// defaults to ON CONFLICT DO UPDATE over every payload column; the column set
// below is byte-checked against that payload object (index.ts:357-372).
const UPSERT_PROVIDER_IMAGE_ATTRIBUTION_SQL = `
  INSERT INTO public.event_image_attributions (
    event_id, image_url, provider, matched_tag,
    pexels_photo_id, pexels_photographer_name, pexels_photographer_profile_url, pexels_photo_url,
    pixabay_photo_id, pixabay_photographer_name, pixabay_photographer_username, pixabay_photo_url
  ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  ON CONFLICT (event_id, image_url) DO UPDATE SET
    provider = EXCLUDED.provider,
    matched_tag = EXCLUDED.matched_tag,
    pexels_photo_id = EXCLUDED.pexels_photo_id,
    pexels_photographer_name = EXCLUDED.pexels_photographer_name,
    pexels_photographer_profile_url = EXCLUDED.pexels_photographer_profile_url,
    pexels_photo_url = EXCLUDED.pexels_photo_url,
    pixabay_photo_id = EXCLUDED.pixabay_photo_id,
    pixabay_photographer_name = EXCLUDED.pixabay_photographer_name,
    pixabay_photographer_username = EXCLUDED.pixabay_photographer_username,
    pixabay_photo_url = EXCLUDED.pixabay_photo_url
`

/** public.list_pending_unsplash_download_tracking(p_limit) */
const LIST_PENDING_UNSPLASH_TRACKING_SQL = `
  SELECT attribution_id::text AS "attributionId", event_id::text AS "eventId",
         image_url AS "imageUrl", download_location AS "downloadLocation", attempts
  FROM public.list_pending_unsplash_download_tracking($1::int)
`

/** public.mark_unsplash_download_tracking_result(p_attribution_id, p_success, p_error) */
const MARK_UNSPLASH_TRACKING_RESULT_SQL = `
  SELECT public.mark_unsplash_download_tracking_result($1::uuid, $2, $3)
`

/** public.list_events_needing_attribution_backfill(p_limit) */
const LIST_EVENTS_NEEDING_ATTRIBUTION_BACKFILL_SQL = `
  SELECT event_id::text AS "eventId", image_url AS "imageUrl"
  FROM public.list_events_needing_attribution_backfill($1::int)
`

// Direct upsert into event_image_attributions — legacy did this client-side
// (backfill-event-enrichment/index.ts:469-485), also stamping
// download_tracking_status='pending' + download_tracking_next_attempt_at=now()
// server-side so the tracking pass claims the row on a later tick. matched_tag
// is always NULL here (index.ts:474): a URL-lookup backfill has no matched tag
// to record.
const UPSERT_UNSPLASH_ATTRIBUTION_BACKFILL_SQL = `
  INSERT INTO public.event_image_attributions (
    event_id, image_url, provider, matched_tag,
    unsplash_photo_id, unsplash_photographer_name, unsplash_photographer_username,
    unsplash_photographer_profile_url, unsplash_photo_url, unsplash_download_location,
    download_tracking_status, download_tracking_next_attempt_at
  ) VALUES ($1::uuid, $2, 'unsplash', NULL, $3, $4, $5, $6, $7, $8, 'pending', now())
  ON CONFLICT (event_id, image_url) DO UPDATE SET
    provider = EXCLUDED.provider,
    matched_tag = EXCLUDED.matched_tag,
    unsplash_photo_id = EXCLUDED.unsplash_photo_id,
    unsplash_photographer_name = EXCLUDED.unsplash_photographer_name,
    unsplash_photographer_username = EXCLUDED.unsplash_photographer_username,
    unsplash_photographer_profile_url = EXCLUDED.unsplash_photographer_profile_url,
    unsplash_photo_url = EXCLUDED.unsplash_photo_url,
    unsplash_download_location = EXCLUDED.unsplash_download_location,
    download_tracking_status = EXCLUDED.download_tracking_status,
    download_tracking_next_attempt_at = EXCLUDED.download_tracking_next_attempt_at
`

// Mirrors ClassificationRepository.loadTagFeatureConfig
// (classification.repository.ts:108-113) with feature = 'parent-tips'.
// Unlike that method, the "openai" provider fallback stays out of this
// query — resolveParentTipsAiConfig (generate-parent-tips.ts:123-161) applies
// its own default when provider is null, so the raw row is returned as-is.
const LOAD_PARENT_TIPS_FEATURE_CONFIG_SQL = `
  SELECT cfg.model_id AS "modelId", models.provider AS provider, cfg.enabled
  FROM public.ai_feature_config cfg
  LEFT JOIN public.approved_ai_models models ON models.id = cfg.model_id
  WHERE cfg.feature = 'parent-tips'
`

// start_datetime is re-serialized as UTC ISO 8601 (same idiom as
// review.repository.ts's LOAD_REVIEW_EVENT_SQL) because DbService leaves
// timestamptz as pg's default text format; ParentTipsCandidate.startDatetime
// is spliced verbatim into the LLM prompt (parent-tips-prompt.ts:74).
const LIST_EVENTS_NEEDING_PARENT_TIPS_SQL = `
  SELECT event_id::text AS "eventId", title, description, age_min AS "ageMin",
         age_max AS "ageMax", is_outdoor AS "isOutdoor", venue_name AS "venueName",
         to_char(start_datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           AS "startDatetime",
         tags
  FROM public.list_events_needing_parent_tips($1::int)
`

/** public.update_event_parent_tips(p_event_id, p_tips, p_provider, p_model, p_prompt_version) */
const UPDATE_EVENT_PARENT_TIPS_SQL = `
  SELECT public.update_event_parent_tips($1::uuid, $2::jsonb, $3, $4, $5)
`

/** public.mark_event_enrichment_attempt(p_event_id) */
const MARK_ENRICHMENT_ATTEMPT_SQL = `
  SELECT public.mark_event_enrichment_attempt($1::uuid)
`

/** public.list_events_needing_embeddings(p_limit) */
const LIST_EVENTS_NEEDING_EMBEDDINGS_SQL = `
  SELECT id::text AS id, title, description
  FROM public.list_events_needing_embeddings($1::int)
`

// Legacy embed-event/handler.ts storeEmbedding (lines 100-120): vector
// serialized as "[v1,v2,...]" text and cast to pgvector, ON CONFLICT
// (event_id) DO UPDATE (supabase-js upsert with onConflict: "event_id").
const UPSERT_EVENT_EMBEDDING_SQL = `
  INSERT INTO public.event_embeddings (event_id, embedding, model, created_at)
  VALUES ($1::uuid, $2::extensions.vector, $3, now())
  ON CONFLICT (event_id) DO UPDATE SET
    embedding = EXCLUDED.embedding,
    model = EXCLUDED.model,
    created_at = EXCLUDED.created_at
`

@Injectable()
export class EnrichmentRepository implements EnrichmentDb, EmbeddingsBackfillDb {
  constructor(private readonly db: DbService) {}

  // ── EnrichmentDb ─────────────────────────────────────────────────────────

  async listEventsNeedingEnrichment(limit: number): Promise<EnrichmentCandidate[]> {
    return this.db.query<EnrichmentCandidate>(LIST_EVENTS_NEEDING_ENRICHMENT_SQL, [limit])
  }

  async listImageEnrichmentInScope(limit: number): Promise<EnrichmentCandidate[]> {
    return this.db.query<EnrichmentCandidate>(LIST_IMAGE_ENRICHMENT_IN_SCOPE_SQL, [limit])
  }

  async getCityContext(cityId: string): Promise<{ name: string; state: string | null } | null> {
    const rows = await this.db.query<{ name: string; state: string | null }>(GET_CITY_CONTEXT_SQL, [
      cityId,
    ])
    return rows[0] ?? null
  }

  async updateEventEnrichment(
    eventId: string,
    latitude: number | null,
    longitude: number | null,
    images: string[] | null
  ): Promise<void> {
    await this.db.query(UPDATE_EVENT_ENRICHMENT_SQL, [
      eventId,
      latitude,
      longitude,
      images === null ? null : JSON.stringify(images),
    ])
  }

  async upsertUnsplashAttributionWithEnrichment(
    params: UnsplashAttributionUpsert
  ): Promise<string | null> {
    const rows = await this.db.query<{ attributionId: string | null }>(
      UPSERT_UNSPLASH_ATTRIBUTION_WITH_ENRICHMENT_SQL,
      [
        params.eventId,
        params.latitude,
        params.longitude,
        JSON.stringify(params.images),
        params.imageUrl,
        params.unsplashPhotoId,
        params.photographerName,
        params.photographerUsername,
        params.photographerProfileUrl,
        params.photoUrl,
        params.downloadLocation,
        params.matchedTag,
      ]
    )
    return rows[0]?.attributionId ?? null
  }

  async upsertProviderImageAttribution(params: ProviderImageAttributionUpsert): Promise<void> {
    await this.db.query(UPSERT_PROVIDER_IMAGE_ATTRIBUTION_SQL, [
      params.eventId,
      params.imageUrl,
      params.provider,
      params.matchedTag,
      params.pexelsPhotoId,
      params.pexelsPhotographerName,
      params.pexelsPhotographerProfileUrl,
      params.pexelsPhotoUrl,
      params.pixabayPhotoId,
      params.pixabayPhotographerName,
      params.pixabayPhotographerUsername,
      params.pixabayPhotoUrl,
    ])
  }

  async listPendingUnsplashTracking(limit: number): Promise<
    Array<{
      attributionId: string
      eventId: string
      imageUrl: string
      downloadLocation: string
      attempts: number
    }>
  > {
    return this.db.query(LIST_PENDING_UNSPLASH_TRACKING_SQL, [limit])
  }

  async markUnsplashTrackingResult(
    attributionId: string,
    success: boolean,
    error?: string
  ): Promise<void> {
    await this.db.query(MARK_UNSPLASH_TRACKING_RESULT_SQL, [attributionId, success, error ?? null])
  }

  async listEventsNeedingAttributionBackfill(
    limit: number
  ): Promise<Array<{ eventId: string; imageUrl: string }>> {
    return this.db.query(LIST_EVENTS_NEEDING_ATTRIBUTION_BACKFILL_SQL, [limit])
  }

  async upsertUnsplashAttributionBackfill(
    params: UnsplashAttributionBackfillUpsert
  ): Promise<void> {
    await this.db.query(UPSERT_UNSPLASH_ATTRIBUTION_BACKFILL_SQL, [
      params.eventId,
      params.imageUrl,
      params.unsplashPhotoId,
      params.photographerName,
      params.photographerUsername,
      params.photographerProfileUrl,
      params.photoUrl,
      params.downloadLocation,
    ])
  }

  // ── ParentTipsDb ─────────────────────────────────────────────────────────

  async loadParentTipsFeatureConfig(): Promise<{
    modelId: string | null
    provider: string | null
    enabled: boolean
  } | null> {
    const rows = await this.db.query<{
      modelId: string | null
      provider: string | null
      enabled: boolean
    }>(LOAD_PARENT_TIPS_FEATURE_CONFIG_SQL)
    return rows[0] ?? null
  }

  async listEventsNeedingParentTips(limit: number): Promise<ParentTipsCandidate[]> {
    return this.db.query<ParentTipsCandidate>(LIST_EVENTS_NEEDING_PARENT_TIPS_SQL, [limit])
  }

  async updateEventParentTips(
    eventId: string,
    tips: ParentTip[],
    provider: string,
    model: string,
    promptVersion: string
  ): Promise<void> {
    // Legacy's ParentTipRecord wire/storage shape is { category, text }
    // (generate-parent-tips/handler.ts:210, 351-358: p_tips = result.tips).
    // ParentTip renames the field to `tip` on the way out of
    // generateParentTipsForEvent (generate-parent-tips.ts deviation #4) —
    // that rename is scoped to the in-process return value only, so the
    // persisted jsonb column is mapped back to legacy's exact field name.
    const payload = tips.map((tip) => ({ category: tip.category, text: tip.tip }))
    await this.db.query(UPDATE_EVENT_PARENT_TIPS_SQL, [
      eventId,
      JSON.stringify(payload),
      provider,
      model,
      promptVersion,
    ])
  }

  async markEnrichmentAttempt(eventId: string): Promise<void> {
    await this.db.query(MARK_ENRICHMENT_ATTEMPT_SQL, [eventId])
  }

  // ── EmbeddingsBackfillDb / EmbedEventDb ──────────────────────────────────

  async listEventsNeedingEmbeddings(
    limit: number
  ): Promise<Array<{ id: string; title: string | null; description: string | null }>> {
    return this.db.query(LIST_EVENTS_NEEDING_EMBEDDINGS_SQL, [limit])
  }

  async upsertEventEmbedding(eventId: string, embedding: number[], model: string): Promise<void> {
    const vectorStr = `[${embedding.join(",")}]`
    await this.db.query(UPSERT_EVENT_EMBEDDING_SQL, [eventId, vectorStr, model])
  }
}
