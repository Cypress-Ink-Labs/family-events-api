import { describe, expect, it } from "vitest"

import { resolveProcessingMode } from "./event-processing.js"
import type { EventSourceRow } from "./types.js"

// Ported from family-events-backend scrape-source/lib/event-processing_test.ts
// (U28), converted from Deno.test to vitest.

function buildSource(overrides: Partial<EventSourceRow> = {}): EventSourceRow {
  return {
    id: "source-1",
    name: "Source",
    url: "https://example.com/feed",
    source_type: "rss",
    extraction_mode: "deterministic",
    processing_mode: "manual_review",
    city_id: null,
    is_active: true,
    auto_approve: false,
    scrape_interval_hours: 24,
    last_scraped_at: null,
    last_status: "pending",
    error_count: 0,
    date_window_days: null,
    consecutive_zero_result_scrapes: 0,
    stale_escalated_at: null,
    ...overrides,
  }
}

describe("resolveProcessingMode", () => {
  it("uses explicit processing_mode when present", () => {
    expect(
      resolveProcessingMode(buildSource({ processing_mode: "llm_review", auto_approve: false }))
    ).toBe("llm_review")
  })

  it("falls back to auto_approve when processing_mode missing", () => {
    expect(resolveProcessingMode(buildSource({ processing_mode: null, auto_approve: true }))).toBe(
      "auto_approve"
    )
    expect(resolveProcessingMode(buildSource({ processing_mode: null, auto_approve: false }))).toBe(
      "manual_review"
    )
  })
})
