import { randomUUID } from "node:crypto"

import type { DbService } from "../../src/db/db.service.js"

export interface EnrichmentFixtureOptions {
  cityName: string
  cityState: string
}

export function createEnrichmentFixtures(db: DbService, options: EnrichmentFixtureOptions) {
  async function seedCity(
    overrides: Partial<{ id: string; latitude: number | null; longitude: number | null }> = {}
  ): Promise<string> {
    const id = overrides.id ?? randomUUID()
    const slug = `test-city-${id.slice(0, 8)}`
    await db.query(
      `INSERT INTO public.cities (id, name, state, slug, timezone, latitude, longitude)
       VALUES ($1, $2, $3, $4, 'America/Chicago', $5, $6)`,
      [
        id,
        options.cityName,
        options.cityState,
        slug,
        overrides.latitude ?? null,
        overrides.longitude ?? null,
      ]
    )
    return id
  }

  async function seedEvent(
    overrides: Partial<{
      id: string
      city_id: string
      status: string
      title: string
      description: string | null
      venue_name: string | null
      address: string | null
      latitude: number | null
      longitude: number | null
      images: string[]
      admin_locked_fields: string[]
      is_featured: boolean
      start_datetime: string
      last_enrichment_attempt_at: string | null
      llm_review_decision: string | null
      parent_tips: object | null
      age_min: number | null
      age_max: number | null
      is_outdoor: boolean | null
      created_at: string | null
    }> = {}
  ): Promise<string> {
    const cityId = overrides.city_id ?? (await seedCity())
    const eventId = overrides.id ?? randomUUID()
    await db.query(
      `INSERT INTO public.events
         (id, city_id, title, description, venue_name, address, start_datetime,
          status, latitude, longitude, images, admin_locked_fields, is_featured,
          last_enrichment_attempt_at, llm_review_decision, parent_tips, age_min, age_max, is_outdoor,
          created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, COALESCE($7::timestamptz, now()),
               $8::public.event_status, $9, $10, COALESCE($11::jsonb, '[]'::jsonb), COALESCE($12::text[], '{}'::text[]), $13,
               $14::timestamptz, $15::public.llm_event_review_decision, $16::jsonb, $17, $18, $19,
               COALESCE($20::timestamptz, now()))`,
      [
        eventId,
        cityId,
        overrides.title ?? "Test Event",
        overrides.description ?? null,
        overrides.venue_name ?? null,
        overrides.address === undefined ? "123 Main St" : overrides.address,
        overrides.start_datetime ?? null,
        overrides.status ?? "draft",
        overrides.latitude ?? null,
        overrides.longitude ?? null,
        overrides.images ? JSON.stringify(overrides.images) : null,
        overrides.admin_locked_fields ?? null,
        overrides.is_featured ?? false,
        overrides.last_enrichment_attempt_at ?? null,
        overrides.llm_review_decision ?? null,
        overrides.parent_tips ? JSON.stringify(overrides.parent_tips) : null,
        overrides.age_min ?? null,
        overrides.age_max ?? null,
        overrides.is_outdoor ?? null,
        overrides.created_at ?? null,
      ]
    )
    return eventId
  }

  async function seedTag(slug: string = `tag-${randomUUID().slice(0, 8)}`): Promise<string> {
    const id = randomUUID()
    await db.query(`INSERT INTO public.tags (id, name, slug) VALUES ($1::uuid, $2, $2)`, [id, slug])
    return id
  }

  async function attachTag(eventId: string, tagId: string, confidence: number): Promise<void> {
    await db.query(
      `INSERT INTO public.event_tags (event_id, tag_id, confidence) VALUES ($1::uuid, $2::uuid, $3)`,
      [eventId, tagId, confidence]
    )
  }

  async function eventById(id: string) {
    const rows = await db.query<{
      latitude: string | null
      longitude: string | null
      images: unknown[]
      updated_at: string
      last_enrichment_attempt_at: string | null
      parent_tips: unknown
      parent_tips_generated_at: string | null
      parent_tips_provider: string | null
      parent_tips_model: string | null
      parent_tips_prompt_version: string | null
    }>(
      `SELECT latitude::text, longitude::text, images, updated_at, last_enrichment_attempt_at,
              parent_tips, parent_tips_generated_at, parent_tips_provider, parent_tips_model,
              parent_tips_prompt_version
       FROM public.events WHERE id = $1::uuid`,
      [id]
    )
    return rows[0]!
  }

  return { seedCity, seedEvent, seedTag, attachTag, eventById }
}

export type EnrichmentFixtures = ReturnType<typeof createEnrichmentFixtures>
