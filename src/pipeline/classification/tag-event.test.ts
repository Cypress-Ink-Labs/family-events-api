import { describe, expect, it } from "vitest"

import type { MemoryContextDb } from "../memory-context.js"
import {
  processTagEvent,
  resolveClassification,
  TagEventRequestError,
  type AvailableTag,
  type CityLocationRow,
  type ClassificationOutput,
  type CurrentEvent,
  type TagAssignmentUpsert,
  type TagEventDb,
  type TagEventDeps,
  type TagEventInput,
  type TagFeatureConfigRow,
  type TagTraceInsert,
} from "./tag-event.js"

// Ported from family-events-backend supabase/functions/tag-event/handler_test.ts
// (U29), converted from Deno.test to vitest. The supabase-js query-builder
// FakeSupabase mock became a FakeTagEventDb recording fake of the TagEventDb
// seam; every scenario and expected value is unchanged except:
// - "handleTagEvent rejects invalid service-role calls" is dropped — auth
//   (requireServiceRole) is an HTTP/controller-layer concern that was removed
//   from this pipeline module (see tag-event.ts file header).
// - Response/status-code assertions became direct return-value/thrown-error
//   assertions on processTagEvent, since there is no HTTP Response anymore.

// ── Fake TagEventDb ──────────────────────────────────────────────────────────

interface FakeEvent extends CurrentEvent {
  id: string
  age_min?: number | null
  age_max?: number | null
  ai_confidence?: number | null
  ai_tag_provider?: string | null
  ai_tag_model?: string | null
  ai_tag_status?: string | null
}

interface FakeTag extends AvailableTag {}

interface FakeEventTag {
  event_id: string
  tag_id: string
  confidence: number
  is_manual_override: boolean
}

class FakeTagEventDb implements TagEventDb {
  events = new Map<string, FakeEvent>()
  tags: FakeTag[] = []
  eventTags: FakeEventTag[] = []
  traces: TagTraceInsert[] = []
  cities = new Map<string, CityLocationRow>()
  aiFeatureConfig: TagFeatureConfigRow | null = null

  loadTagFeatureConfig(): Promise<TagFeatureConfigRow | null> {
    return Promise.resolve(this.aiFeatureConfig)
  }

  getEventForTagging(eventId: string): Promise<CurrentEvent | null> {
    return Promise.resolve(this.events.get(eventId) ?? null)
  }

  listAvailableTags(): Promise<AvailableTag[]> {
    return Promise.resolve(this.tags)
  }

  insertTagTrace(row: TagTraceInsert): Promise<void> {
    this.traces.push(row)
    return Promise.resolve()
  }

  listManualOverrideTagIds(eventId: string): Promise<string[]> {
    return Promise.resolve(
      this.eventTags
        .filter((row) => row.event_id === eventId && row.is_manual_override)
        .map((row) => row.tag_id)
    )
  }

  deleteAutoAssignedTags(eventId: string): Promise<void> {
    this.eventTags = this.eventTags.filter(
      (row) => !(row.event_id === eventId && !row.is_manual_override)
    )
    return Promise.resolve()
  }

  upsertTagAssignments(rows: TagAssignmentUpsert[]): Promise<void> {
    for (const row of rows) {
      const existingIndex = this.eventTags.findIndex(
        (existing) => existing.event_id === row.event_id && existing.tag_id === row.tag_id
      )
      if (existingIndex >= 0) {
        this.eventTags[existingIndex] = row
      } else {
        this.eventTags.push(row)
      }
    }
    return Promise.resolve()
  }

  getCityLocation(cityId: string): Promise<CityLocationRow | null> {
    return Promise.resolve(this.cities.get(cityId) ?? null)
  }

  updateEventAfterTagging(eventId: string, payload: Record<string, unknown>): Promise<void> {
    const event = this.events.get(eventId)
    if (event) {
      Object.assign(event, payload)
      this.events.set(eventId, event)
    }
    return Promise.resolve()
  }
}

// Never expected to be called in these tests: OPENAI_API_KEY is always unset
// via `getEnv`, so both memory-context lookup and auto-embed short-circuit
// before touching memoryDb / embedEvent / generateEmbedding.
const unusedMemoryDb: MemoryContextDb = {
  getMemoryFeatureFlag: () => Promise.reject(new Error("unexpected memoryDb call")),
  findSimilarEvents: () => Promise.reject(new Error("unexpected memoryDb call")),
  fetchEventTagsForEvents: () => Promise.reject(new Error("unexpected memoryDb call")),
  fetchTagDecisionsForEvents: () => Promise.reject(new Error("unexpected memoryDb call")),
  fetchReviewEventsByIds: () => Promise.reject(new Error("unexpected memoryDb call")),
  fetchStatusDecisionsForEvents: () => Promise.reject(new Error("unexpected memoryDb call")),
}

function buildDeps(db: TagEventDb, overrides: Partial<TagEventDeps> = {}): TagEventDeps {
  return {
    db,
    memoryDb: unusedMemoryDb,
    embedEvent: () => Promise.reject(new Error("unexpected embedEvent call")),
    generateEmbedding: () => Promise.reject(new Error("unexpected generateEmbedding call")),
    getEnv: () => undefined,
    geocode: () => Promise.resolve(null),
    ...overrides,
  }
}

// ── processTagEvent ──────────────────────────────────────────────────────────

describe("processTagEvent", () => {
  it("rejects requests without a title", async () => {
    const db = new FakeTagEventDb()
    const deps = buildDeps(db)

    await expect(processTagEvent({}, deps)).rejects.toThrow(TagEventRequestError)
    await expect(processTagEvent({}, deps)).rejects.toThrow("title is required")
    expect(db.traces.length).toBe(0)
  })

  it("preserves manual tags and only fills missing event fields", async () => {
    const db = new FakeTagEventDb()
    db.tags = [
      { id: "tag-free", slug: "free", name: "Free" },
      { id: "tag-outdoor", slug: "outdoor", name: "Outdoor" },
      { id: "tag-manual", slug: "manual", name: "Manual" },
    ]
    db.events.set("evt-1", {
      id: "evt-1",
      title: "Existing park meetup",
      description: "Old description",
      price: 9,
      is_free: false,
      venue_name: "Existing Venue",
      address: null,
      latitude: null,
      longitude: null,
      city_id: "city-1",
    })
    db.eventTags = [
      { event_id: "evt-1", tag_id: "tag-manual", confidence: 1, is_manual_override: true },
      { event_id: "evt-1", tag_id: "tag-old", confidence: 0.25, is_manual_override: false },
    ]
    db.cities.set("city-1", {
      name: "Baton Rouge",
      state: "LA",
      latitude: 30.4515,
      longitude: -91.1871,
    })

    const geocodeQueries: string[] = []
    const deps = buildDeps(db, {
      classify: (): Promise<ClassificationOutput> =>
        Promise.resolve({
          classification: {
            tags: [
              { slug: "outdoor", confidence: 0.9, reason: "park" },
              { slug: "free", confidence: 0.8, reason: "free" },
            ],
            ageMin: 3,
            ageMax: 8,
            price: 12,
            isFree: true,
            venueName: "New Venue",
            provider: "openai",
            reasoningSummary: "classified",
            status: "success",
            fallbackReason: null,
            model: "gpt-4o-mini",
          },
          llmUsage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            llmLatencyMs: 25,
            finishReason: "stop",
          },
        }),
      geocode: (query: string) => {
        geocodeQueries.push(query)
        return Promise.resolve(null)
      },
    })

    const body = await processTagEvent(
      {
        event_id: "evt-1",
        title: "Fresh park meetup",
        source_run_id: "run-1",
        trigger_type: "reclassify",
      },
      deps
    )

    expect(body.status).toBe("success")
    expect(body.overall_confidence).toBe(0.8500000000000001)

    const updatedEvent = db.events.get("evt-1")
    expect(updatedEvent?.price).toBe(9)
    expect(updatedEvent?.is_free).toBe(true)
    expect(updatedEvent?.venue_name).toBe("Existing Venue")
    expect(updatedEvent?.age_min).toBe(3)
    expect(updatedEvent?.age_max).toBe(8)
    expect(updatedEvent?.latitude).toBe(30.4515)
    expect(updatedEvent?.longitude).toBe(-91.1871)
    expect(updatedEvent?.ai_tag_status).toBe("success")
    expect(geocodeQueries[0]).toContain("Existing Venue")

    expect(db.traces.length).toBe(1)
    expect(db.traces[0]?.event_id).toBe("evt-1")
    expect(db.traces[0]?.source_run_id).toBe("run-1")
    expect(db.traces[0]?.status).toBe("success")
    expect(db.traces[0]?.predicted_fields).toEqual({
      age_min: 3,
      age_max: 8,
      price: 12,
      is_free: true,
      venue_name: "New Venue",
    })

    expect(db.eventTags.map((row) => `${row.tag_id}:${row.is_manual_override}`).sort()).toEqual([
      "tag-free:false",
      "tag-manual:true",
      "tag-outdoor:false",
    ])
  })

  it("normalizes fractional AI age ranges before persistence", async () => {
    const db = new FakeTagEventDb()
    db.tags = [{ id: "tag-storytime", slug: "storytime", name: "Storytime" }]
    db.events.set("evt-fractional-age", {
      id: "evt-fractional-age",
      title: "Little Gym at the Library",
      description: "For children 2.5 years to 5 years old.",
      price: null,
      is_free: true,
      venue_name: null,
      address: null,
      latitude: 30,
      longitude: -90,
      city_id: null,
    })

    const deps = buildDeps(db, {
      classify: (): Promise<ClassificationOutput> =>
        Promise.resolve({
          classification: {
            tags: [{ slug: "storytime", confidence: 0.82, reason: "library" }],
            ageMin: 2.5,
            ageMax: 5,
            price: null,
            isFree: true,
            venueName: "South Regional Library",
            provider: "openai",
            reasoningSummary: "classified",
            status: "success",
            fallbackReason: null,
            model: "gpt-4o-mini",
          },
          llmUsage: null,
        }),
    })

    const body = await processTagEvent(
      { event_id: "evt-fractional-age", title: "Little Gym at the Library" },
      deps
    )

    expect(body.age_min).toBe(2)
    expect(body.age_max).toBe(5)

    const updatedEvent = db.events.get("evt-fractional-age")
    expect(updatedEvent?.age_min).toBe(2)
    expect(updatedEvent?.age_max).toBe(5)
    expect(db.traces[0]?.predicted_fields).toEqual({
      age_min: 2,
      age_max: 5,
      price: null,
      is_free: true,
      venue_name: "South Regional Library",
    })
  })

  it("returns fallback output from classification failures", async () => {
    const db = new FakeTagEventDb()
    db.tags = [{ id: "tag-storytime", slug: "storytime", name: "Storytime" }]
    const deps = buildDeps(db, {
      classify: (): Promise<ClassificationOutput> =>
        Promise.resolve({
          classification: {
            tags: [{ slug: "storytime", confidence: 0.7, reason: "keyword" }],
            ageMin: null,
            ageMax: null,
            price: null,
            isFree: false,
            venueName: null,
            provider: "openai",
            reasoningSummary: "Keyword fallback classified this event.",
            status: "fallback",
            fallbackReason: "openai classification failed (500)",
            model: "gpt-4o-mini",
          },
          llmUsage: null,
        }),
    })

    const body = await processTagEvent(
      { title: "Library storytime", description: "Stories and songs." },
      deps
    )

    expect(body.status).toBe("fallback")
    expect(body.fallback_reason).toBe("openai classification failed (500)")
    expect(body.processed).toBe(true)
    // No event_id in the request -> nothing to persist a trace against.
    expect(db.traces.length).toBe(0)
  })

  it("includes prompt_version in trace insert", async () => {
    const db = new FakeTagEventDb()
    db.tags = [{ id: "tag-outdoor", slug: "outdoor", name: "Outdoor" }]
    db.events.set("evt-pv", {
      id: "evt-pv",
      title: "Park day",
      description: "Outdoor fun",
      price: null,
      is_free: true,
      venue_name: null,
      address: null,
      latitude: 30,
      longitude: -90,
      city_id: null,
    })

    const deps = buildDeps(db, {
      classify: (): Promise<ClassificationOutput> =>
        Promise.resolve({
          classification: {
            tags: [{ slug: "outdoor", confidence: 0.9, reason: "park" }],
            ageMin: null,
            ageMax: null,
            price: null,
            isFree: true,
            venueName: null,
            provider: "openai" as const,
            reasoningSummary: null,
            status: "success" as const,
            fallbackReason: null,
            model: "gpt-4.1-nano",
          },
          llmUsage: null,
        }),
    })

    await processTagEvent({ event_id: "evt-pv", title: "Park day" }, deps)

    expect(db.traces.length).toBe(1)
    const promptVersion = db.traces[0]?.prompt_version
    expect(typeof promptVersion).toBe("string")
    expect((promptVersion as string).length).toBeGreaterThan(0)
  })
})

// ── resolveClassification ────────────────────────────────────────────────────

function withoutEnv<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

describe("resolveClassification", () => {
  const envKeys = ["AI_PROVIDER", "AI_BASE_URL", "AI_API_KEY", "OPENAI_API_KEY", "OPENAI_MODEL"]

  it("falls back to keyword tags without provider credentials", async () => {
    await withoutEnv(envKeys, async () => {
      const input: TagEventInput = {
        eventId: null,
        sourceRunId: null,
        triggerType: "import",
        traceStartedAt: Date.now(),
        title: "Free outdoor storytime for ages 2 to 5 years",
        description: "Meet at the park for a no cost library reading.",
        currentEvent: null,
      }
      const availableTags: AvailableTag[] = [
        { id: "tag-storytime", slug: "storytime", name: "Storytime" },
        { id: "tag-outdoor", slug: "outdoor", name: "Outdoor" },
        { id: "tag-free", slug: "free", name: "Free" },
      ]

      const result = await resolveClassification(input, availableTags)

      expect(result.llmUsage).toBeNull()
      expect(result.classification.status).toBe("fallback")
      expect(result.classification.fallbackReason).toBe("AI provider is not configured")
      expect(result.classification.ageMin).toBe(2)
      expect(result.classification.ageMax).toBe(5)
      expect(result.classification.isFree).toBe(true)
      expect(result.classification.tags.some((tag) => tag.slug === "storytime")).toBe(true)
      expect(result.classification.tags.some((tag) => tag.slug === "outdoor")).toBe(true)
      expect(result.classification.tags.some((tag) => tag.slug === "free")).toBe(true)
    })
  })

  it("uses model from DB config when provided", async () => {
    await withoutEnv(["AI_PROVIDER", "AI_MODEL", "AI_BASE_URL", "AI_API_KEY"], async () => {
      const input: TagEventInput = {
        eventId: null,
        sourceRunId: null,
        triggerType: "import",
        traceStartedAt: Date.now(),
        title: "Story time at the park",
        description: "Free outdoor reading for kids.",
        currentEvent: null,
      }

      const result = await resolveClassification(
        input,
        [{ id: "tag-outdoor", slug: "outdoor", name: "Outdoor" }],
        { modelId: "gpt-4.1-nano", provider: "openai", enabled: true }
      )

      // No API key configured so falls back to keyword classification,
      // but the model name from DB config flows through to the result.
      expect(result.classification.model).toBe("gpt-4.1-nano")
      expect(result.classification.status).toBe("fallback")
    })
  })
})
