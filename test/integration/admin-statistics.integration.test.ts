import { randomUUID } from "node:crypto"

import { ForbiddenException } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { AdminStatisticsRepository } from "../../src/admin/admin-statistics.repository.js"
import { AdminStatisticsService } from "../../src/admin/admin-statistics.service.js"
import type { DbService } from "../../src/db/db.service.js"

import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

let db: DbService
let service: AdminStatisticsService
let actor: string

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  service = new AdminStatisticsService(new AdminStatisticsRepository(db))
})
afterAll(async () => db.onModuleDestroy())
beforeEach(async () => {
  await truncateAdminCatalog(db)
  actor = randomUUID()
  await db.query("INSERT INTO auth.users (id) VALUES ($1)", [actor])
  await db.query("INSERT INTO public.user_profiles (id, role) VALUES ($1, 'admin')", [actor])
  await db.query("INSERT INTO public.user_access (user_id, is_enabled) VALUES ($1, true)", [actor])
})

async function source(name: string | null = "Calendar"): Promise<string> {
  const id = randomUUID()
  await db.query("INSERT INTO public.event_sources (id, name, url) VALUES ($1, $2, $3)", [
    id,
    name ?? `Unnamed ${id}`,
    `https://example.com/${id}`,
  ])
  return id
}

async function event(
  status: "draft" | "published" | "rejected",
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const row = {
    id: randomUUID(),
    title: "Statistics fixture",
    start_datetime: "2026-12-01T10:00:00Z",
    status,
    updated_at: new Date(),
    ...overrides,
  }
  const keys = Object.keys(row)
  await db.query(
    `INSERT INTO public.events (${keys.join(", ")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(", ")})`,
    Object.values(row)
  )
  return row.id
}

describe("admin dashboard statistics", () => {
  it("enforces authorization and returns empty values with a raw generated timestamp", async () => {
    await expect(service.dashboard(randomUUID())).rejects.toBeInstanceOf(ForbiddenException)
    const stats = await service.dashboard(actor)
    expect(stats).toMatchObject({
      total_events: 0,
      draft_events: 0,
      published_events: 0,
      ai_confidence: { high: 0, medium: 0, low: 0 },
      sources: { active: 0, errors: 0 },
      dead_letters: {
        tag_queue: 0,
        source_queue: 0,
        oldest_tag_dead_at: null,
        oldest_source_dead_at: null,
      },
    })
    expect(stats.generated_at).toMatch(/\.\d{1,6}[+-]\d\d(?::?\d\d)?$/)
  })

  it("counts event confidence, active/error sources, and both dead-letter queues", async () => {
    const active = await source()
    const failed = await source("Failed")
    await db.query("UPDATE public.event_sources SET last_status = 'error' WHERE id = $1", [failed])
    const high = await event("published", { ai_confidence: 0.95, source_id: active })
    await event("draft", { ai_confidence: 0.8, source_id: failed })
    await event("rejected", { ai_confidence: 0.2 })
    await event("draft", { ai_confidence: null })
    await db.query(
      "INSERT INTO public.event_tag_queue (event_id, status, finished_at) VALUES ($1, 'dead', '2026-06-01T01:02:03.123456Z')",
      [high]
    )
    await db.query(
      "INSERT INTO public.source_scrape_queue (source_id, status, finished_at) VALUES ($1, 'dead', '2026-06-02T01:02:03.654321Z')",
      [active]
    )
    expect(await service.dashboard(actor)).toMatchObject({
      total_events: 4,
      draft_events: 2,
      published_events: 1,
      ai_confidence: { high: 1, medium: 1, low: 1 },
      sources: { active: 2, errors: 1 },
      dead_letters: {
        tag_queue: 1,
        source_queue: 1,
        oldest_tag_dead_at: expect.stringContaining(".123456"),
        oldest_source_dead_at: expect.stringContaining(".654321"),
      },
    })
  })
})

describe("pipeline learning statistics", () => {
  it("enforces authorization and preserves the production empty feature flag mismatch", async () => {
    await expect(service.pipeline(randomUUID(), 30)).rejects.toBeInstanceOf(ForbiddenException)
    expect(await service.pipeline(actor, 30)).toEqual({
      window_days: 30,
      total_reviewed: 0,
      llm_reviewed: 0,
      admin_reviewed: 0,
      auto_rejected: 0,
      memory_hits: 0,
      total_embeddings: 0,
      tag_memory_hits: 0,
      top_rejection_sources: [],
      feature_flags: {},
    })
  })

  it("applies windowing, all counters, nullable source names, and min-three rejection ranking", async () => {
    const ranked = await source("Ranked")
    const belowMinimum = await source("Too small")
    const events = [
      await event("rejected", { source_id: ranked, source_name: null }),
      await event("rejected", { source_id: ranked, source_name: null }),
      await event("published", { source_id: ranked, source_name: null }),
      await event("rejected", { source_id: belowMinimum }),
      await event("published", { source_id: belowMinimum }),
    ]
    // The production search trigger overwrites updated_at on every insert/update.
    // Disable it only while seeding an intentionally out-of-window row.
    await db.query("ALTER TABLE public.events DISABLE TRIGGER events_search_vector_trigger")
    try {
      await event("published", { updated_at: "2020-01-01T00:00:00Z" })
    } finally {
      await db.query("ALTER TABLE public.events ENABLE TRIGGER events_search_vector_trigger")
    }
    await db.query(
      `INSERT INTO public.event_llm_review_traces
       (event_id, prompt_version, status, flags) VALUES
       ($1, 'v1', 'succeeded', ARRAY['source_auto_rejected', 'memory_context_used']),
       ($2, 'v1', 'failed', ARRAY[]::text[])`,
      [events[0], events[1]]
    )
    await db.query(
      `INSERT INTO public.admin_event_decisions (event_id, admin_user_id, decision_type)
       VALUES ($1, $2, 'status_change')`,
      [events[0], actor]
    )
    await db.query(
      `INSERT INTO public.event_ai_traces
       (event_id, input_title, predicted_fields)
       VALUES ($1, 'fixture', '{"memory_context":{"used":"true"}}')`,
      [events[0]]
    )
    await db.query(
      "INSERT INTO public.event_embeddings (event_id, embedding) VALUES ($1, $2::extensions.vector)",
      [events[0], `[${Array(1536).fill(0).join(",")}]`]
    )

    const stats = await service.pipeline(actor, 30)
    expect(stats).toMatchObject({
      window_days: 30,
      total_reviewed: 5,
      llm_reviewed: 1,
      admin_reviewed: 1,
      auto_rejected: 1,
      memory_hits: 1,
      total_embeddings: 1,
      tag_memory_hits: 1,
      feature_flags: {},
    })
    expect(stats.top_rejection_sources).toEqual([
      {
        source_id: ranked,
        source_name: null,
        total: 3,
        rejected: 2,
        rejection_rate: 66.7,
      },
    ])
    expect(stats.top_rejection_sources[0]!.rejection_rate).toBeGreaterThanOrEqual(0)
    expect(stats.top_rejection_sources[0]!.rejection_rate).toBeLessThanOrEqual(100)
  })
})
