import { describe, expect, it } from "vitest"
import {
  ADMIN_REVIEW_EDGE_CASES,
  APPROVAL_CRITERIA,
  buildReviewPrompt,
  FLAGS,
  LLM_EVENT_REVIEW_PROMPT_VERSION,
  REJECTION_CRITERIA,
} from "./prompt.js"

// Ported from family-events-backend supabase/functions/event-review/prompt_test.ts (U29)

const baseInput = {
  eventId: "event-1",
  title: "Family Story Time",
  description: "Bring your kids for books and songs.",
  startDatetime: "2026-06-01T14:00:00Z",
  endDatetime: null,
  timezone: "America/Chicago",
  venueName: "Main Library",
  address: "10 Main St",
  sourceName: "Library Feed",
  sourceUrl: "https://example.com/event/1",
  category: "storytime",
  tags: ["storytime"],
}

describe("buildReviewPrompt", () => {
  it("contains approval criteria", () => {
    const prompt = buildReviewPrompt(baseInput)
    expect(prompt.systemPrompt).toContain(APPROVAL_CRITERIA[0])
  })

  it("contains rejection criteria", () => {
    const prompt = buildReviewPrompt(baseInput)
    expect(prompt.systemPrompt).toContain(REJECTION_CRITERIA[0])
  })

  it("contains admin-review edge cases", () => {
    const prompt = buildReviewPrompt(baseInput)
    expect(prompt.systemPrompt).toContain(ADMIN_REVIEW_EDGE_CASES[0])
  })

  it("includes strict JSON schema contract", () => {
    const prompt = buildReviewPrompt(baseInput)
    expect(prompt.systemPrompt).toContain("Return JSON ONLY using this exact schema")
    expect(prompt.systemPrompt).toContain("approve|reject|needs_admin_review")
  })

  it("delimiters untrusted event data", () => {
    const prompt = buildReviewPrompt(baseInput)
    expect(prompt.userPrompt).toMatch(/BEGIN_UNTRUSTED_EVENT_JSON/)
    expect(prompt.userPrompt).toMatch(/END_UNTRUSTED_EVENT_JSON/)
  })

  it("version is exported and stable", () => {
    expect(LLM_EVENT_REVIEW_PROMPT_VERSION).toBe("event-review-v2")
    const prompt = buildReviewPrompt(baseInput)
    expect(prompt.systemPrompt).toContain(LLM_EVENT_REVIEW_PROMPT_VERSION)
  })

  it("contains security rules", () => {
    const prompt = buildReviewPrompt(baseInput)
    expect(prompt.systemPrompt).toContain("Security rules:")
    expect(prompt.systemPrompt).toContain("untrusted data")
    expect(prompt.systemPrompt).toContain("prompt_injection_attempt")
  })

  it("contains output rules", () => {
    const prompt = buildReviewPrompt(baseInput)
    expect(prompt.systemPrompt).toContain("Output rules:")
    expect(prompt.systemPrompt).toContain("Return valid JSON only")
  })

  it("contains decision criteria sections", () => {
    const prompt = buildReviewPrompt(baseInput)
    expect(prompt.systemPrompt).toContain("Approve when all are true:")
    expect(prompt.systemPrompt).toContain("Reject when any are clearly true:")
    expect(prompt.systemPrompt).toContain("Use needs_admin_review when:")
  })

  it("contains flags list", () => {
    const prompt = buildReviewPrompt(baseInput)
    for (const flag of FLAGS) {
      expect(prompt.systemPrompt).toContain(`"${flag}"`)
    }
  })
})
