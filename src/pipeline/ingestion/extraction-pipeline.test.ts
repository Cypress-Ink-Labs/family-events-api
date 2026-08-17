import { describe, expect, it } from "vitest"

import {
  normalizeArtifactForLlm,
  parseLlmParsedEvents,
  selectExtractionPlan,
  validateParsedEvents,
} from "./extraction-pipeline.js"
import type { ParsedEvent } from "./types.js"

// Ported from family-events-backend scrape-source/lib/extraction-pipeline_test.ts
// (U28), converted from Deno.test to vitest; selectExtractionPlan cases added.

const validEvent: ParsedEvent = {
  title: "Story Time",
  description: "Books and songs.",
  startDatetime: "2026-06-01T10:00:00-05:00",
  endDatetime: null,
  venueName: "Library",
  address: null,
  sourceUrl: "https://example.com/events/story-time",
  imageUrl: null,
  images: [],
  price: null,
  isFree: true,
}

describe("validateParsedEvents", () => {
  it("rejects invalid dates", () => {
    expect(validateParsedEvents([validEvent]).length).toBe(1)
    expect(validateParsedEvents([{ ...validEvent, startDatetime: "not-a-date" }]).length).toBe(0)
    expect(validateParsedEvents([{ ...validEvent, endDatetime: "not-a-date" }]).length).toBe(0)
  })
})

describe("parseLlmParsedEvents", () => {
  it("accepts canonical events and rejects invalid rows", () => {
    expect(parseLlmParsedEvents(JSON.stringify({ events: [validEvent] }))).toEqual([validEvent])
    expect(() =>
      parseLlmParsedEvents(JSON.stringify({ events: [{ ...validEvent, startDatetime: "" }] }))
    ).toThrow(/missing required ParsedEvent fields|invalid ParsedEvent/)
  })
})

describe("normalizeArtifactForLlm", () => {
  it("caps input size", () => {
    const normalized = normalizeArtifactForLlm({
      url: "https://example.com",
      contentType: "text/html",
      body: "a".repeat(25_000),
    })
    expect(normalized.length).toBe(20_000)
  })
})

describe("selectExtractionPlan", () => {
  it("uses only the requested extractor for fixed modes", () => {
    expect(selectExtractionPlan("deterministic", 0)).toEqual(["deterministic"])
    expect(selectExtractionPlan("llm", 5)).toEqual(["llm"])
  })

  it("falls back to llm only when deterministic found nothing", () => {
    expect(selectExtractionPlan("deterministic_then_llm", 3)).toEqual(["deterministic"])
    expect(selectExtractionPlan("deterministic_then_llm", 0)).toEqual(["deterministic", "llm"])
  })
})
