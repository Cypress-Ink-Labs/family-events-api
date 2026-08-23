import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  type AdminDecisionRow,
  type EventTagRow,
  type MemoryContextDb,
  type ReviewAdminDecisionRow,
  type ReviewEventRow,
  type SimilarEventRow,
  type SimilarEventReviewContext,
  type SimilarEventTagContext,
  fetchSimilarEventTagContext,
  fetchSimilarReviewContext,
  formatReviewMemoryPrompt,
  formatTagMemoryPrompt,
  isMemoryFeatureEnabled,
} from "./memory-context.js"

// Ported from family-events-backend supabase/functions/_shared/memory-context_test.ts
// (U29, post plan-036 bulk hydration). The Supabase query-builder recording
// mock became a recording fake of MemoryContextDb; the isMemoryFeatureEnabled
// coverage at the bottom is new (upstream had none for that helper).

// ── formatTagMemoryPrompt tests ──────────────────────────────────────────────

describe("formatTagMemoryPrompt", () => {
  it("returns empty string for no contexts", () => {
    expect(formatTagMemoryPrompt([])).toBe("")
  })

  it("formats single event with AI tags", () => {
    const contexts: SimilarEventTagContext[] = [
      {
        eventId: "evt-1",
        title: "Kids Music Class",
        cosineDistance: 0.12,
        tags: [
          { slug: "music", name: "Music", source: "ai", confidence: 0.9 },
          { slug: "indoor", name: "Indoor", source: "ai", confidence: 0.7 },
        ],
        adminCorrected: false,
        adminReason: null,
      },
    ]

    const result = formatTagMemoryPrompt(contexts)
    expect(result.includes("MEMORY CONTEXT")).toBe(true)
    expect(result.includes("Kids Music Class")).toBe(true)
    expect(result.includes("music")).toBe(true)
    expect(result.includes("indoor")).toBe(true)
    expect(result.includes("admin-corrected")).toBe(false)
  })

  it("highlights admin corrections", () => {
    const contexts: SimilarEventTagContext[] = [
      {
        eventId: "evt-2",
        title: "Art Workshop for Families",
        cosineDistance: 0.15,
        tags: [
          { slug: "art", name: "Art", source: "admin", confidence: 1.0 },
          { slug: "outdoor", name: "Outdoor", source: "ai", confidence: 0.8 },
        ],
        adminCorrected: true,
        adminReason: "Added art tag, this is primarily an art event",
      },
    ]

    const result = formatTagMemoryPrompt(contexts)
    expect(result.includes("admin-corrected")).toBe(true)
    expect(result.includes("[ADMIN CORRECTED]")).toBe(true)
    expect(result.includes("Admin reason:")).toBe(true)
    expect(result.includes("primarily an art event")).toBe(true)
  })

  it("includes reference instruction", () => {
    const contexts: SimilarEventTagContext[] = [
      {
        eventId: "evt-1",
        title: "Test",
        cosineDistance: 0.1,
        tags: [{ slug: "music", name: "Music", source: "ai", confidence: 0.9 }],
        adminCorrected: false,
        adminReason: null,
      },
    ]

    const result = formatTagMemoryPrompt(contexts)
    expect(result.includes("Admin-corrected tags are higher-quality signals")).toBe(true)
  })
})

// ── formatReviewMemoryPrompt tests ───────────────────────────────────────────

describe("formatReviewMemoryPrompt", () => {
  it("returns empty string for no contexts", () => {
    expect(formatReviewMemoryPrompt([])).toBe("")
  })

  it("formats approved and rejected events", () => {
    const contexts: SimilarEventReviewContext[] = [
      {
        eventId: "evt-1",
        title: "Kids Yoga",
        cosineDistance: 0.1,
        status: "published",
        llmReviewDecision: "approve",
        adminOverridden: false,
        adminDecision: null,
        adminReason: null,
      },
      {
        eventId: "evt-2",
        title: "Adult Only Event",
        cosineDistance: 0.2,
        status: "rejected",
        llmReviewDecision: "reject",
        adminOverridden: false,
        adminDecision: null,
        adminReason: null,
      },
    ]

    const result = formatReviewMemoryPrompt(contexts)
    expect(result.includes("MEMORY CONTEXT")).toBe(true)
    expect(result.includes("Kids Yoga")).toBe(true)
    expect(result.includes("published")).toBe(true)
    expect(result.includes("Adult Only Event")).toBe(true)
    expect(result.includes("rejected")).toBe(true)
  })

  it("highlights admin overrides", () => {
    const contexts: SimilarEventReviewContext[] = [
      {
        eventId: "evt-1",
        title: "Community Garden Day",
        cosineDistance: 0.1,
        status: "published",
        llmReviewDecision: "needs_admin_review",
        adminOverridden: true,
        adminDecision: "published",
        adminReason: "This is a family-friendly community event",
      },
    ]

    const result = formatReviewMemoryPrompt(contexts)
    expect(result.includes("admin-overridden")).toBe(true)
    expect(result.includes("Admin reason:")).toBe(true)
    expect(result.includes("family-friendly community event")).toBe(true)
    expect(result.includes("Admin-overridden decisions are stronger signals")).toBe(true)
  })
})

// ── Recording fake of MemoryContextDb ────────────────────────────────────────

interface FakeCall {
  method: string
  args: unknown
}

interface FakeDbResponses {
  similar?: SimilarEventRow[]
  flag?: { enabled: boolean } | null
  flagError?: Error
  tagRows?: EventTagRow[]
  tagRowsError?: Error
  tagDecisionRows?: AdminDecisionRow[]
  tagDecisionRowsError?: Error
  reviewEventRows?: ReviewEventRow[]
  reviewEventRowsError?: Error
  statusDecisionRows?: ReviewAdminDecisionRow[]
  statusDecisionRowsError?: Error
}

function makeFakeMemoryContextDb(responses: FakeDbResponses): {
  db: MemoryContextDb
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []

  const db: MemoryContextDb = {
    async getMemoryFeatureFlag(feature) {
      calls.push({ method: "getMemoryFeatureFlag", args: feature })
      if (responses.flagError) throw responses.flagError
      return responses.flag ?? null
    },
    async findSimilarEvents(args) {
      calls.push({ method: "findSimilarEvents", args })
      return responses.similar ?? []
    },
    async fetchEventTagsForEvents(eventIds) {
      calls.push({ method: "fetchEventTagsForEvents", args: eventIds })
      if (responses.tagRowsError) throw responses.tagRowsError
      return responses.tagRows ?? []
    },
    async fetchTagDecisionsForEvents(eventIds) {
      calls.push({ method: "fetchTagDecisionsForEvents", args: eventIds })
      if (responses.tagDecisionRowsError) throw responses.tagDecisionRowsError
      return responses.tagDecisionRows ?? []
    },
    async fetchReviewEventsByIds(eventIds) {
      calls.push({ method: "fetchReviewEventsByIds", args: eventIds })
      if (responses.reviewEventRowsError) throw responses.reviewEventRowsError
      return responses.reviewEventRows ?? []
    },
    async fetchStatusDecisionsForEvents(eventIds) {
      calls.push({ method: "fetchStatusDecisionsForEvents", args: eventIds })
      if (responses.statusDecisionRowsError) throw responses.statusDecisionRowsError
      return responses.statusDecisionRows ?? []
    },
  }

  return { db, calls }
}

const similarEvents: SimilarEventRow[] = [
  {
    event_id: "evt-3",
    title: "Third event",
    cosine_distance: 0.03,
    source_id: null,
    city_id: null,
    status: "",
  },
  {
    event_id: "evt-1",
    title: "First event",
    cosine_distance: 0.1,
    source_id: null,
    city_id: null,
    status: "",
  },
  {
    event_id: "evt-5",
    title: "Fifth event",
    cosine_distance: 0.2,
    source_id: null,
    city_id: null,
    status: "",
  },
  {
    event_id: "evt-2",
    title: "Second event",
    cosine_distance: 0.25,
    source_id: null,
    city_id: null,
    status: "",
  },
  {
    event_id: "evt-4",
    title: "Fourth event",
    cosine_distance: 0.3,
    source_id: null,
    city_id: null,
    status: "",
  },
]
const similarEventIds = similarEvents.map((event) => event.event_id)

// ── fetchSimilarEventTagContext ──────────────────────────────────────────────

describe("fetchSimilarEventTagContext", () => {
  it("bulk-loads tags and latest decisions in similarity order", async () => {
    const { db, calls } = makeFakeMemoryContextDb({
      similar: similarEvents,
      tagRows: [
        {
          event_id: "evt-1",
          tag_id: "ai-tag",
          confidence: 0.99,
          is_manual_override: false,
          tags: { slug: "ai", name: "AI" },
        },
        {
          event_id: "evt-3",
          tag_id: "low-tag",
          confidence: 0.4,
          is_manual_override: false,
          tags: { slug: "low", name: "Low" },
        },
        {
          event_id: "evt-3",
          tag_id: "admin-tag",
          confidence: 0.1,
          is_manual_override: true,
          tags: { slug: "admin", name: "Admin" },
        },
      ],
      tagDecisionRows: [
        {
          event_id: "evt-1",
          decision_type: "tag_edit",
          new_tags: [],
          reason: "newest evt-1 correction",
          created_at: "2026-07-24T12:00:00Z",
        },
        {
          event_id: "evt-3",
          decision_type: "status_and_tags",
          new_tags: [],
          reason: "latest evt-3 correction",
          created_at: "2026-07-24T11:00:00Z",
        },
        {
          event_id: "evt-1",
          decision_type: "tag_edit",
          new_tags: [],
          reason: "older evt-1 correction",
          created_at: "2026-07-24T10:00:00Z",
        },
      ],
    })

    const contexts = await fetchSimilarEventTagContext(db, [0.1], null, null)

    expect(calls.map((call) => call.method)).toEqual([
      "findSimilarEvents",
      "fetchEventTagsForEvents",
      "fetchTagDecisionsForEvents",
    ])
    expect(contexts.map((context) => context.eventId)).toEqual(similarEventIds)
    expect(contexts[0]?.tags.map((tag) => tag.slug)).toEqual(["admin", "low"])
    expect(contexts[1]?.adminReason).toBe("newest evt-1 correction")
    expect(contexts[0]?.adminReason).toBe("latest evt-3 correction")
    expect(calls[1]?.args).toEqual(similarEventIds)
    expect(calls[2]?.args).toEqual(similarEventIds)
  })
})

// ── fetchSimilarReviewContext ────────────────────────────────────────────────

describe("fetchSimilarReviewContext", () => {
  it("bulk-loads review state and skips missing events", async () => {
    const { db, calls } = makeFakeMemoryContextDb({
      similar: similarEvents,
      reviewEventRows: [
        { id: "evt-2", status: "rejected", llm_review_decision: "reject" },
        { id: "evt-3", status: "published", llm_review_decision: "approve" },
        { id: "evt-1", status: "published", llm_review_decision: "approve" },
        { id: "evt-4", status: "published", llm_review_decision: "approve" },
      ],
      statusDecisionRows: [
        {
          event_id: "evt-1",
          decision_type: "status_change",
          new_status: "published",
          reason: "newest evt-1 status",
          created_at: "2026-07-24T12:00:00Z",
        },
        {
          event_id: "evt-3",
          decision_type: "status_change",
          new_status: "rejected",
          reason: "newest evt-3 status",
          created_at: "2026-07-24T11:00:00Z",
        },
        {
          event_id: "evt-1",
          decision_type: "status_change",
          new_status: "rejected",
          reason: "older evt-1 status",
          created_at: "2026-07-24T10:00:00Z",
        },
      ],
    })

    const result = await fetchSimilarReviewContext(db, [0.1], null, null)

    expect(calls.map((call) => call.method)).toEqual([
      "findSimilarEvents",
      "fetchReviewEventsByIds",
      "fetchStatusDecisionsForEvents",
    ])
    expect(result.contexts.map((context) => context.eventId)).toEqual([
      "evt-3",
      "evt-1",
      "evt-2",
      "evt-4",
    ])
    expect(result.contexts[1]?.adminDecision).toBe("published")
    expect(result.contexts[0]?.adminDecision).toBe("rejected")
    expect(result.confidenceAdjustment).toEqual({
      delta: 0,
      reason: "mixed outcomes among similar events",
      approvedCount: 3,
      rejectedCount: 1,
      totalSimilar: 4,
    })
    expect(calls[1]?.args).toEqual(similarEventIds)
    expect(calls[2]?.args).toEqual(similarEventIds)
  })
})

// ── Bulk-failure fallbacks ───────────────────────────────────────────────────

describe("memory context bulk-failure fallbacks", () => {
  let warningMessages: unknown[][] = []
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warningMessages = []
    warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warningMessages.push(args)
    })
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it("returns established empty fallbacks and warns once for each bulk failure", async () => {
    const scenarios = [
      ["tag", "tagRowsError"],
      ["tag", "tagDecisionRowsError"],
      ["review", "reviewEventRowsError"],
      ["review", "statusDecisionRowsError"],
    ] as const

    for (const [helper, failingField] of scenarios) {
      const { db } = makeFakeMemoryContextDb({
        similar: similarEvents,
        [failingField]: new Error(`${failingField} failed`),
      })

      if (helper === "tag") {
        expect(await fetchSimilarEventTagContext(db, [0.1], null, null)).toEqual([])
      } else {
        const result = await fetchSimilarReviewContext(db, [0.1], null, null)
        expect(result.contexts).toEqual([])
        expect(result.confidenceAdjustment.delta).toBe(0)
        expect(result.confidenceAdjustment.approvedCount).toBe(0)
        expect(result.confidenceAdjustment.rejectedCount).toBe(0)
        expect(result.confidenceAdjustment.totalSimilar).toBe(0)
      }
    }

    expect(warningMessages.length).toBe(4)
    expect(warningMessages.map(([entry]) => JSON.parse(String(entry)).message)).toEqual([
      "memory-context: failed to bulk fetch tags for similar events",
      "memory-context: failed to bulk fetch tag decisions for similar events",
      "memory-context: failed to bulk fetch review events",
      "memory-context: failed to bulk fetch review decisions",
    ])
  })
})

// ── isMemoryFeatureEnabled ────────────────────────────────────────────────────
// New coverage — upstream memory-context_test.ts had none for this helper.

describe("isMemoryFeatureEnabled", () => {
  it("returns true when the flag row is enabled", async () => {
    const { db } = makeFakeMemoryContextDb({ flag: { enabled: true } })
    expect(await isMemoryFeatureEnabled(db, "tag-memory")).toBe(true)
  })

  it("returns false when the flag row is disabled", async () => {
    const { db } = makeFakeMemoryContextDb({ flag: { enabled: false } })
    expect(await isMemoryFeatureEnabled(db, "review-memory")).toBe(false)
  })

  it("returns false when no row matches (maybeSingle -> null)", async () => {
    const { db } = makeFakeMemoryContextDb({ flag: null })
    expect(await isMemoryFeatureEnabled(db, "source-auto-reject")).toBe(false)
  })

  it("returns false when the DB query throws", async () => {
    const { db } = makeFakeMemoryContextDb({ flagError: new Error("db unavailable") })
    expect(await isMemoryFeatureEnabled(db, "source-auto-reject")).toBe(false)
  })

  // CodeRabbit U29 review: the catch must log via logEdgeEvent like every
  // other failure path in this module (upstream's catch was silent).
  it("logs a warning with feature and error when the DB query throws", async () => {
    const warnings: unknown[][] = []
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args)
    })
    try {
      const { db } = makeFakeMemoryContextDb({ flagError: new Error("db unavailable") })
      expect(await isMemoryFeatureEnabled(db, "tag-memory")).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }

    expect(warnings.length).toBe(1)
    const entry = JSON.parse(String(warnings[0]?.[0]))
    expect(entry.message).toBe("memory-context: failed to read memory feature flag")
    expect(entry.feature).toBe("tag-memory")
    expect(entry.error).toBe("db unavailable")
  })
})
