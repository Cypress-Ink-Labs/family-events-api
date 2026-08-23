import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { ClassificationRepository } from "../../src/pipeline/classification/classification.repository.js"
import type { TagTraceInsert } from "../../src/pipeline/classification/tag-event.js"
import type { EventInputs } from "../../src/pipeline/classification/process-tag-queue.js"
import type {
  AdminDecisionRow,
  EventTagRow,
  ReviewAdminDecisionRow,
} from "../../src/pipeline/memory-context.js"
import type { DbService } from "../../src/db/db.service.js"

import { createIntegrationDb } from "./db.js"
import { ensureIngestionSchema, truncateIngestion } from "./ingestion-catalog.js"

// U29: real-database correctness tests for ClassificationRepository, the pg
// implementation of the three classification seams (TagEventDb, TagQueueDb,
// MemoryContextDb). Every case seeds real rows and re-queries actual DB state
// after each call.
//
// Excluded from coverage: findSimilarEvents. The disposable integration
// database has no pgvector extension (and the fixture deliberately avoids
// embeddings), so the find_similar_events RPC cannot be installed here —
// deviation documented on the PR.

let db: DbService
let repo: ClassificationRepository

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureIngestionSchema(db)
  repo = new ClassificationRepository(db)
})

afterAll(async () => {
  await db.onModuleDestroy()
})

beforeEach(async () => {
  await truncateIngestion(db)
})

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedCity(
  overrides: Partial<{
    name: string
    state: string | null
    latitude: number
    longitude: number
  }> = {}
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.cities (id, name, state, slug, timezone, latitude, longitude)
     VALUES ($1::uuid, $2, $3, $4, 'America/Chicago', $5::numeric, $6::numeric)`,
    [
      id,
      overrides.name ?? "Lafayette",
      overrides.state === undefined ? "LA" : overrides.state,
      `slug-${id.slice(0, 8)}`,
      overrides.latitude ?? 30.2241,
      overrides.longitude ?? -92.0198,
    ]
  )
  return id
}

async function seedEvent(
  overrides: Partial<{
    title: string
    description: string | null
    city_id: string | null
    price: number | null
    is_free: boolean
    venue_name: string | null
    address: string | null
    latitude: number | null
    longitude: number | null
  }> = {}
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.events
       (id, title, description, start_datetime, city_id, price, is_free,
        venue_name, address, latitude, longitude)
     VALUES ($1::uuid, $2, $3, '2026-07-01T15:00:00Z', $4::uuid, $5::numeric, $6::boolean,
             $7, $8, $9::numeric, $10::numeric)`,
    [
      id,
      overrides.title ?? "Story Time at the Park",
      overrides.description === undefined ? "Books and songs for toddlers." : overrides.description,
      overrides.city_id === undefined ? null : overrides.city_id,
      overrides.price === undefined ? null : overrides.price,
      overrides.is_free ?? false,
      overrides.venue_name ?? "Main Library",
      overrides.address ?? "301 W Congress St",
      overrides.latitude ?? 30.2241,
      overrides.longitude ?? -92.0198,
    ]
  )
  return id
}

async function seedTag(name: string): Promise<string> {
  const id = randomUUID()
  await db.query("INSERT INTO public.tags (id, name, slug) VALUES ($1::uuid, $2, $3)", [
    id,
    name,
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  ])
  return id
}

async function linkEventTag(
  eventId: string,
  tagId: string,
  confidence: number,
  isManualOverride: boolean
): Promise<void> {
  await db.query(
    `INSERT INTO public.event_tags (event_id, tag_id, confidence, is_manual_override)
     VALUES ($1::uuid, $2::uuid, $3::numeric, $4::boolean)`,
    [eventId, tagId, confidence, isManualOverride]
  )
}

async function seedDecision(
  eventId: string,
  opts: {
    decisionType: "status_change" | "tag_edit" | "status_and_tags"
    createdAt: string
    reason?: string | null
    newTags?: Array<Record<string, unknown>> | null
    newStatus?: string | null
  }
): Promise<void> {
  await db.query(
    `INSERT INTO public.admin_event_decisions
       (event_id, decision_type, new_status, new_tags, reason, created_at)
     VALUES ($1::uuid, $2, $3::public.event_status, $4::jsonb, $5, $6::timestamptz)`,
    [
      eventId,
      opts.decisionType,
      opts.newStatus ?? null,
      opts.newTags === undefined || opts.newTags === null ? null : JSON.stringify(opts.newTags),
      opts.reason === undefined ? null : opts.reason,
      opts.createdAt,
    ]
  )
}

async function seedModel(id: string, provider = "openai"): Promise<void> {
  await db.query(
    `INSERT INTO public.approved_ai_models (id, provider, display_name)
     VALUES ($1, $2, $3)`,
    [id, provider, `Display ${id}`]
  )
}

async function seedFeatureConfig(
  feature: string,
  modelId: string,
  enabled: boolean
): Promise<void> {
  await db.query(
    "INSERT INTO public.ai_feature_config (feature, model_id, enabled) VALUES ($1, $2, $3)",
    [feature, modelId, enabled]
  )
}

// ── Queue helpers ────────────────────────────────────────────────────────────

async function enqueue(
  overrides: Partial<{
    event_id: string
    source_run_id: string | null
    trigger_type: string
    status: string
    next_attempt_at: string | null
    started_at: string | null
  }> = {}
): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO public.event_tag_queue
       (event_id, source_run_id, trigger_type, status, next_attempt_at, started_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::public.event_tag_queue_status,
             COALESCE($5::timestamptz, now()), $6::timestamptz)
     RETURNING id::int AS id`,
    [
      overrides.event_id ?? randomUUID(),
      overrides.source_run_id ?? null,
      overrides.trigger_type ?? "import",
      overrides.status ?? "pending",
      overrides.next_attempt_at ?? null,
      overrides.started_at ?? null,
    ]
  )
  return rows[0]!.id
}

async function queueRowById(id: number) {
  const rows = await db.query<{
    status: string
    attempt_count: number
    started_at: string | null
    next_attempt_at: string
    finished_at: string | null
    last_error: string | null
  }>(
    `SELECT status::text, attempt_count, started_at, next_attempt_at, finished_at, last_error
     FROM public.event_tag_queue WHERE id = $1::bigint`,
    [id]
  )
  return rows[0]!
}

/** Claim + mark-started, mirroring how the worker drives a row to active. */
async function activateRow(eventId?: string): Promise<number> {
  const id = await enqueue({ event_id: eventId })
  await repo.claimTagQueueBatch(1)
  await repo.markTagQueueRowStarted(id)
  return id
}

const num = (value: unknown): number => Number(value)

// ── TagEventDb ───────────────────────────────────────────────────────────────

describe("TagEventDb.loadTagFeatureConfig", () => {
  it("joins ai_feature_config to approved_ai_models for the tagging feature", async () => {
    await seedModel("gpt-5.4-nano")
    await seedFeatureConfig("tagging", "gpt-5.4-nano", true)

    const config = await repo.loadTagFeatureConfig()

    expect(config).toEqual({ modelId: "gpt-5.4-nano", provider: "openai", enabled: true })
  })

  it("returns null when no tagging row exists", async () => {
    await seedModel("gpt-5.4")
    await seedFeatureConfig("event-review", "gpt-5.4", false)

    expect(await repo.loadTagFeatureConfig()).toBeNull()
  })
})

describe("TagEventDb.getEventForTagging", () => {
  it("returns the current event payload for the classifier", async () => {
    const cityId = await seedCity()
    const eventId = await seedEvent({
      title: "Puppet Show",
      description: "Hand puppets for ages 3+.",
      city_id: cityId,
      price: 5.5,
      is_free: false,
      venue_name: "Downtown Stage",
      address: "12 Main St",
    })

    const event = await repo.getEventForTagging(eventId)

    expect(event).not.toBeNull()
    expect(event!.title).toBe("Puppet Show")
    expect(event!.description).toBe("Hand puppets for ages 3+.")
    expect(num(event!.price)).toBe(5.5)
    expect(event!.is_free).toBe(false)
    expect(event!.venue_name).toBe("Downtown Stage")
    expect(event!.address).toBe("12 Main St")
    expect(num(event!.latitude)).toBeCloseTo(30.2241, 5)
    expect(num(event!.longitude)).toBeCloseTo(-92.0198, 5)
    expect(event!.city_id).toBe(cityId)
  })

  it("returns null when the event does not exist", async () => {
    expect(await repo.getEventForTagging(randomUUID())).toBeNull()
  })
})

describe("TagEventDb.listAvailableTags", () => {
  it("lists id/slug/name for every tag", async () => {
    const outdoors = await seedTag("Outdoors")
    const free = await seedTag("Free")

    const tags = await repo.listAvailableTags()

    expect(tags).toHaveLength(2)
    expect(tags.map((tag) => tag.id).sort()).toEqual([outdoors, free].sort())
    expect(tags.every((tag) => typeof tag.slug === "string" && typeof tag.name === "string")).toBe(
      true
    )
  })

  it("returns [] when no tags exist", async () => {
    expect(await repo.listAvailableTags()).toEqual([])
  })
})

describe("TagEventDb.insertTagTrace", () => {
  it("lands a row in event_ai_traces with jsonb columns intact", async () => {
    const eventId = await seedEvent({ title: "Trace Me", description: null })
    const sourceRunId = randomUUID()
    const trace: TagTraceInsert = {
      event_id: eventId,
      source_run_id: sourceRunId,
      trigger_type: "reclassify",
      provider: "openai",
      model: "gpt-5.4-nano",
      status: "success",
      prompt_version: "v2",
      input_title: "Trace Me",
      input_description: null,
      available_tag_slugs: ["outdoors", "free"],
      predicted_tags: [
        {
          slug: "outdoors",
          confidence: 0.92,
          reason: "park mentioned",
          matched_keywords: ["park"],
        },
        { slug: "free", confidence: 0.5, reason: null, matched_keywords: [] },
      ],
      predicted_fields: {
        age_min: 3,
        age_max: 8,
        memory_context: { used: true, similar_event_ids: [randomUUID()], admin_corrected_count: 1 },
      },
      reasoning_summary: "Matched keywords in title.",
      fallback_reason: null,
      processing_ms: 421,
    }

    await repo.insertTagTrace(trace)

    const [row] = await db.query<Record<string, unknown>>(
      `SELECT * FROM public.event_ai_traces WHERE event_id = $1::uuid`,
      [eventId]
    )
    expect(row).toBeDefined()
    expect(row!["source_run_id"]).toBe(sourceRunId)
    expect(row!["trigger_type"]).toBe("reclassify")
    expect(row!["provider"]).toBe("openai")
    expect(row!["model"]).toBe("gpt-5.4-nano")
    expect(row!["status"]).toBe("success")
    expect(row!["prompt_version"]).toBe("v2")
    expect(row!["input_title"]).toBe("Trace Me")
    expect(row!["input_description"]).toBeNull()
    expect(row!["available_tag_slugs"]).toEqual(["outdoors", "free"])
    expect(row!["predicted_tags"]).toEqual([
      { slug: "outdoors", confidence: 0.92, reason: "park mentioned", matched_keywords: ["park"] },
      { slug: "free", confidence: 0.5, reason: null, matched_keywords: [] },
    ])
    expect(row!["predicted_fields"]).toMatchObject({
      age_min: 3,
      age_max: 8,
      memory_context: { used: true, admin_corrected_count: 1 },
    })
    expect(row!["reasoning_summary"]).toBe("Matched keywords in title.")
    expect(row!["fallback_reason"]).toBeNull()
    expect(row!["processing_ms"]).toBe(421)
  })
})

describe("TagEventDb manual overrides", () => {
  async function seedOverrideScenario(): Promise<{
    eventId: string
    manualA: string
    autoB: string
    manualC: string
  }> {
    const eventId = await seedEvent()
    const manualA = await seedTag("Manual A")
    const autoB = await seedTag("Auto B")
    const manualC = await seedTag("Manual C")
    await linkEventTag(eventId, manualA, 0.99, true)
    await linkEventTag(eventId, autoB, 0.8, false)
    await linkEventTag(eventId, manualC, 0.7, true)
    return { eventId, manualA, autoB, manualC }
  }

  it("listManualOverrideTagIds returns only manually-overridden tag ids", async () => {
    const { eventId, manualA, manualC } = await seedOverrideScenario()

    const ids = await repo.listManualOverrideTagIds(eventId)

    expect([...ids].sort()).toEqual([manualA, manualC].sort())
  })

  it("deleteAutoAssignedTags removes auto rows and keeps manual overrides", async () => {
    const { eventId, manualA, manualC } = await seedOverrideScenario()

    await repo.deleteAutoAssignedTags(eventId)

    const remaining = await db.query<{ tag_id: string }>(
      "SELECT tag_id FROM public.event_tags WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(remaining.map((row) => row.tag_id).sort()).toEqual([manualA, manualC].sort())
  })
})

describe("TagEventDb.upsertTagAssignments", () => {
  it("inserts new assignments and updates confidence on (event_id, tag_id) conflict", async () => {
    const eventId = await seedEvent()
    const existing = await seedTag("Existing")
    const fresh = await seedTag("Fresh")
    await linkEventTag(eventId, existing, 0.5, false)

    await repo.upsertTagAssignments([
      { event_id: eventId, tag_id: fresh, confidence: 0.9, is_manual_override: false },
      { event_id: eventId, tag_id: existing, confidence: 0.95, is_manual_override: true },
    ])

    const rows = await db.query<{
      tag_id: string
      confidence: string
      is_manual_override: boolean
    }>(
      `SELECT tag_id, confidence, is_manual_override
       FROM public.event_tags WHERE event_id = $1::uuid ORDER BY tag_id`,
      [eventId]
    )
    expect(rows).toHaveLength(2)
    const byTag = new Map(rows.map((row) => [row.tag_id, row]))
    // supabase-js .upsert() defaults to ON CONFLICT DO UPDATE over ALL payload
    // columns, so a conflict refreshes both confidence and is_manual_override
    // from the payload (the handler happens to always pass false today).
    expect(byTag.get(fresh)?.confidence).toBe("0.900")
    expect(byTag.get(fresh)?.is_manual_override).toBe(false)
    expect(byTag.get(existing)?.confidence).toBe("0.950")
    expect(byTag.get(existing)?.is_manual_override).toBe(true)
  })
})

describe("TagEventDb.getCityLocation", () => {
  it("returns name/state/lat/lng for the event's city", async () => {
    const cityId = await seedCity({
      name: "Broussard",
      state: "LA",
      latitude: 30.1474,
      longitude: -91.9551,
    })

    const city = await repo.getCityLocation(cityId)

    expect(city).not.toBeNull()
    expect(city!.name).toBe("Broussard")
    expect(city!.state).toBe("LA")
    expect(num(city!.latitude)).toBeCloseTo(30.1474, 5)
    expect(num(city!.longitude)).toBeCloseTo(-91.9551, 5)
  })

  it("returns null for an unknown city", async () => {
    expect(await repo.getCityLocation(randomUUID())).toBeNull()
  })
})

describe("TagEventDb.updateEventAfterTagging", () => {
  it("writes the classification columns onto the events row", async () => {
    const eventId = await seedEvent()

    await repo.updateEventAfterTagging(eventId, {
      ai_confidence: 0.87,
      ai_tag_provider: "openai",
      ai_tag_model: "gpt-5.4-nano",
      ai_tag_status: "success",
      age_min: 3,
      age_max: 8,
    })

    const [row] = await db.query<Record<string, unknown>>(
      `SELECT ai_confidence, ai_tag_provider, ai_tag_model, ai_tag_status, age_min, age_max
       FROM public.events WHERE id = $1::uuid`,
      [eventId]
    )
    expect(num(row!["ai_confidence"])).toBeCloseTo(0.87, 3)
    expect(row!["ai_tag_provider"]).toBe("openai")
    expect(row!["ai_tag_model"]).toBe("gpt-5.4-nano")
    expect(row!["ai_tag_status"]).toBe("success")
    expect(row!["age_min"]).toBe(3)
    expect(row!["age_max"]).toBe(8)
  })
})

// ── TagQueueDb ───────────────────────────────────────────────────────────────

describe("TagQueueDb.reapStuckTagQueueRows", () => {
  it("returns stuck processing rows to pending with a reap last_error", async () => {
    const id = await enqueue({ status: "processing", started_at: "2026-06-01T00:00:00Z" })

    expect(await repo.reapStuckTagQueueRows()).toBe(1)
    const row = await queueRowById(id)
    expect(row.status).toBe("pending")
    expect(row.started_at).toBeNull()
    expect(row.last_error).toBe("reaped after stuck in processing")
  })

  it("does not touch rows that are not stuck", async () => {
    const id = await enqueue({ status: "processing", started_at: null })

    expect(await repo.reapStuckTagQueueRows()).toBe(0)
    expect((await queueRowById(id)).status).toBe("processing")
  })
})

describe("TagQueueDb.claimTagQueueBatch", () => {
  it("claims oldest-next_attempt_at first, transitions to processing, and drains", async () => {
    const secondEvent = randomUUID()
    const first = await enqueue({ next_attempt_at: "2026-06-01T00:00:00Z" })
    const second = await enqueue({ event_id: secondEvent, next_attempt_at: "2026-06-02T00:00:00Z" })

    const firstBatch = await repo.claimTagQueueBatch(1)
    expect(firstBatch).toHaveLength(1)
    expect(firstBatch[0]!.id).toBe(first)
    expect(firstBatch[0]!.attempt_count).toBe(0)
    expect(firstBatch[0]!.trigger_type).toBe("import")
    expect(firstBatch[0]!.source_run_id).toBeNull()
    expect(typeof firstBatch[0]!.event_id).toBe("string")

    const firstRow = await queueRowById(first)
    expect(firstRow.status).toBe("processing")

    const secondBatch = await repo.claimTagQueueBatch(1)
    expect(secondBatch.map((row) => row.id)).toEqual([second])
    expect(await repo.claimTagQueueBatch(1)).toEqual([])
  })

  it("never claims rows parked in the future or already finished", async () => {
    await enqueue({ next_attempt_at: "2199-01-01T00:00:00Z" })
    await enqueue({ status: "succeeded" })
    expect(await repo.claimTagQueueBatch(5)).toEqual([])
  })
})

describe("TagQueueDb.markTagQueueRowStarted", () => {
  it("increments attempt_count and stamps started_at in the returned row and the DB", async () => {
    const id = await enqueue()
    await repo.claimTagQueueBatch(1)

    const started = await repo.markTagQueueRowStarted(id)

    expect(started.id).toBe(id)
    expect(started.attempt_count).toBe(1)
    const row = await queueRowById(id)
    expect(row.attempt_count).toBe(1)
    expect(row.started_at).not.toBeNull()
  })
})

describe("TagQueueDb.releaseUnstartedTagQueueRows", () => {
  it("returns unstarted claims to pending with started_at cleared", async () => {
    const id = await enqueue()
    await repo.claimTagQueueBatch(1)

    await repo.releaseUnstartedTagQueueRows([id])

    const row = await queueRowById(id)
    expect(row.status).toBe("pending")
    expect(row.started_at).toBeNull()
  })

  it("leaves rows that were already marked started alone", async () => {
    const id = await activateRow()

    await repo.releaseUnstartedTagQueueRows([id])

    expect((await queueRowById(id)).status).toBe("processing")
  })
})

describe("TagQueueDb completion writes", () => {
  it("completeTagQueueRow writes status + finished_at and clears last_error", async () => {
    const id = await activateRow()

    await repo.completeTagQueueRow(id, "succeeded")

    const row = await queueRowById(id)
    expect(row.status).toBe("succeeded")
    expect(row.finished_at).not.toBeNull()
    expect(row.last_error).toBeNull()
  })

  it("markTagQueueRowDead dead-letters with the error message", async () => {
    const id = await activateRow()

    await repo.markTagQueueRowDead(id, "LLM exploded")

    const row = await queueRowById(id)
    expect(row.status).toBe("dead")
    expect(row.finished_at).not.toBeNull()
    expect(row.last_error).toBe("LLM exploded")
  })

  it("scheduleTagQueueRetry parks the row pending with next_attempt_at, error, cleared started_at", async () => {
    const id = await activateRow()
    const nextAttemptAt = new Date(Date.now() + 60_000).toISOString()

    await repo.scheduleTagQueueRetry(id, nextAttemptAt, "transient 503")

    const row = await queueRowById(id)
    expect(row.status).toBe("pending")
    expect(row.started_at).toBeNull()
    expect(Date.parse(row.next_attempt_at)).toBe(Date.parse(nextAttemptAt))
    expect(row.last_error).toBe("transient 503")
  })
})

describe("TagQueueDb.countPendingTagQueueRows", () => {
  it("counts only pending rows", async () => {
    await enqueue()
    await enqueue()
    await enqueue({ status: "processing" })
    await enqueue({ status: "succeeded" })
    await enqueue({ status: "dead" })

    expect(await repo.countPendingTagQueueRows()).toBe(2)
  })
})

describe("TagQueueDb.fetchEventInputs / fetchEventInputsBulk", () => {
  let inputs: Array<{ id: string; title: string; description: string }> = []

  beforeEach(async () => {
    inputs = []
    for (const title of ["Bulk One", "Bulk Two"]) {
      const id = await seedEvent({ title, description: `${title} description.` })
      inputs.push({ id, title, description: `${title} description.` })
    }
  })

  it("fetchEventInputs reads title/description for one event and null for missing", async () => {
    const found: EventInputs | null = await repo.fetchEventInputs(inputs[0]!.id)
    expect(found).toEqual({ title: "Bulk One", description: "Bulk One description." })

    expect(await repo.fetchEventInputs(randomUUID())).toBeNull()
  })

  it("fetchEventInputsBulk maps found events and omits missing ids", async () => {
    const missing = randomUUID()

    const map = await repo.fetchEventInputsBulk([inputs[0]!.id, inputs[1]!.id, missing])

    expect(map).toBeInstanceOf(Map)
    expect(map.size).toBe(2)
    expect(map.has(missing)).toBe(false)
    expect(map.get(inputs[0]!.id)).toEqual({
      title: "Bulk One",
      description: "Bulk One description.",
    })
    expect(map.get(inputs[1]!.id)).toEqual({
      title: "Bulk Two",
      description: "Bulk Two description.",
    })
  })

  it("fetchEventInputsBulk returns an empty map for an empty id list", async () => {
    expect((await repo.fetchEventInputsBulk([])).size).toBe(0)
  })
})

// ── MemoryContextDb ──────────────────────────────────────────────────────────

describe("MemoryContextDb.getMemoryFeatureFlag", () => {
  it("returns the enabled flag when the feature row exists", async () => {
    await seedModel("gpt-5.4-nano")
    await seedFeatureConfig("tag-memory", "gpt-5.4-nano", false)

    expect(await repo.getMemoryFeatureFlag("tag-memory")).toEqual({ enabled: false })
  })

  it("returns null when the feature has no row", async () => {
    expect(await repo.getMemoryFeatureFlag("review-memory")).toBeNull()
  })
})

describe("MemoryContextDb.fetchEventTagsForEvents", () => {
  it("joins tags.slug/name with confidence and override flags", async () => {
    const eventA = await seedEvent()
    const eventB = await seedEvent()
    const tagA = await seedTag("Sports")
    const tagB = await seedTag("Arts")
    await linkEventTag(eventA, tagA, 0.92, true)
    await linkEventTag(eventA, tagB, 0.41, false)

    const rows: EventTagRow[] = await repo.fetchEventTagsForEvents([eventA, eventB])

    expect(rows).toHaveLength(2)
    const byTag = new Map(rows.map((row) => [row.tag_id, row]))
    const sports = byTag.get(tagA)!
    expect(sports.event_id).toBe(eventA)
    expect(sports.tags).toEqual({ slug: "sports", name: "Sports" })
    expect(sports.is_manual_override).toBe(true)
    expect(sports.confidence).toBeCloseTo(0.92, 3)
    const arts = byTag.get(tagB)!
    expect(arts.tags).toEqual({ slug: "arts", name: "Arts" })
    expect(arts.is_manual_override).toBe(false)
    // eventB has no tag links and contributes no rows.
    expect(rows.every((row) => row.event_id === eventA)).toBe(true)
  })

  it("preserves rows whose joined tags row is gone (null tags)", async () => {
    // The defensive `tags: null` shape in EventTagRow is normally unreachable
    // because event_tags.tag_id FKs to tags ON DELETE CASCADE — fabricate the
    // orphan once by disabling RI triggers on tags (the cascade trigger lives
    // on the referenced table; superuser on a disposable database), then
    // confirm the LEFT JOIN keeps the row with null tags.
    const eventId = await seedEvent()
    const doomedTag = await seedTag("Ghost")
    await linkEventTag(eventId, doomedTag, 0.66, false)
    await db.query("ALTER TABLE public.tags DISABLE TRIGGER ALL")
    try {
      await db.query("DELETE FROM public.tags WHERE id = $1::uuid", [doomedTag])

      const rows: EventTagRow[] = await repo.fetchEventTagsForEvents([eventId])

      expect(rows).toHaveLength(1)
      expect(rows[0]!.tag_id).toBe(doomedTag)
      expect(rows[0]!.tags).toBeNull()
    } finally {
      await db.query("ALTER TABLE public.tags ENABLE TRIGGER ALL")
    }
  })
})

describe("MemoryContextDb.fetchTagDecisionsForEvents", () => {
  it("returns only tag_edit/status_and_tags decisions, newest first", async () => {
    const eventA = await seedEvent()
    const eventB = await seedEvent()
    await seedDecision(eventA, {
      decisionType: "tag_edit",
      createdAt: "2026-06-01T00:00:00Z",
      reason: "older correction",
      newTags: [{ tag_id: randomUUID(), slug: "sports", name: "Sports" }],
    })
    await seedDecision(eventA, {
      decisionType: "status_and_tags",
      createdAt: "2026-06-03T00:00:00Z",
      reason: "newest combined correction",
      newStatus: "published",
      newTags: [{ tag_id: randomUUID(), slug: "free", name: "Free" }],
    })
    await seedDecision(eventA, {
      decisionType: "status_change",
      createdAt: "2026-06-04T00:00:00Z",
      newStatus: "rejected",
    })
    await seedDecision(eventB, {
      decisionType: "tag_edit",
      createdAt: "2026-06-02T00:00:00Z",
      reason: "other event",
    })

    const rows: AdminDecisionRow[] = await repo.fetchTagDecisionsForEvents([eventA, eventB])

    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.decision_type)).toEqual([
      "status_and_tags",
      "tag_edit",
      "tag_edit",
    ])
    // Newest-first across the whole batch.
    const times = rows.map((row) => Date.parse(row.created_at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(rows[0]!.event_id).toBe(eventA)
    expect(rows[0]!.reason).toBe("newest combined correction")
    expect(rows[0]!.new_tags).toEqual([expect.objectContaining({ slug: "free", name: "Free" })])
    expect(rows.some((row) => row.decision_type === "status_change")).toBe(false)
  })
})

describe("MemoryContextDb.fetchReviewEventsByIds", () => {
  it("bulk reads id/status/llm_review_decision for exactly the requested ids", async () => {
    const approved = await seedEvent()
    const rejected = await seedEvent()
    const unreviewed = await seedEvent()
    await db.query(
      `UPDATE public.events SET status = 'published',
         llm_review_decision = 'approve'
       WHERE id = $1::uuid`,
      [approved]
    )
    await db.query(
      `UPDATE public.events SET status = 'rejected',
         llm_review_decision = 'reject'
       WHERE id = $1::uuid`,
      [rejected]
    )

    const rows = await repo.fetchReviewEventsByIds([approved, rejected, randomUUID()])

    expect(rows).toHaveLength(2)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(approved)).toMatchObject({
      status: "published",
      llm_review_decision: "approve",
    })
    expect(byId.get(rejected)).toMatchObject({ status: "rejected", llm_review_decision: "reject" })
    expect(byId.has(unreviewed)).toBe(false)
  })
})

describe("MemoryContextDb.fetchStatusDecisionsForEvents", () => {
  it("returns only status_change decisions with new_status, newest first", async () => {
    const eventA = await seedEvent()
    const eventB = await seedEvent()
    await seedDecision(eventA, {
      decisionType: "status_change",
      createdAt: "2026-06-01T00:00:00Z",
      newStatus: "draft",
      reason: "older status change",
    })
    await seedDecision(eventA, {
      decisionType: "status_change",
      createdAt: "2026-06-05T00:00:00Z",
      newStatus: "published",
      reason: "latest status change",
    })
    await seedDecision(eventA, {
      decisionType: "tag_edit",
      createdAt: "2026-06-06T00:00:00Z",
    })
    await seedDecision(eventB, {
      decisionType: "status_change",
      createdAt: "2026-06-03T00:00:00Z",
      newStatus: "rejected",
      reason: "other event",
    })

    const rows: ReviewAdminDecisionRow[] = await repo.fetchStatusDecisionsForEvents([
      eventA,
      eventB,
    ])

    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.new_status)).toEqual(["published", "rejected", "draft"])
    const times = rows.map((row) => Date.parse(row.created_at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(rows[0]!.reason).toBe("latest status change")
    expect(rows.every((row) => row.decision_type === "status_change")).toBe(true)
  })
})
