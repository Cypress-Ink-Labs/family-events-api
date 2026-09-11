import { describe, expect, it } from "vitest"

import { parseDashboardStats, parsePipelineStats } from "./admin-statistics.service.js"

describe("admin statistics RPC parsing", () => {
  it("converts only safe counts and preserves generated_at", () => {
    const generated_at = "2026-01-02T03:04:05.123456+00:00"
    expect(
      parseDashboardStats({
        total_events: "3",
        draft_events: 1,
        published_events: "2",
        ai_confidence: { high: "1", medium: "1", low: "0" },
        sources: { active: "4", errors: "1" },
        dead_letters: {
          tag_queue: "0",
          source_queue: 0,
          oldest_tag_dead_at: null,
          oldest_source_dead_at: null,
        },
        generated_at,
      })
    ).toMatchObject({ total_events: 3, generated_at })
    expect(() =>
      parseDashboardStats({
        total_events: "9007199254740992",
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
        generated_at,
      })
    ).toThrow()
  })

  it("characterizes nullable source names, bounded rates, and returned flags", () => {
    const value = {
      window_days: 30,
      total_reviewed: "3",
      llm_reviewed: 1,
      admin_reviewed: 2,
      auto_rejected: 0,
      memory_hits: 1,
      total_embeddings: 8,
      tag_memory_hits: 1,
      top_rejection_sources: [
        {
          source_id: "10000000-0000-4000-8000-000000000001",
          source_name: null,
          total: 3,
          rejected: 1,
          rejection_rate: 33.3,
        },
      ],
      feature_flags: { event_review_enabled: true },
    }
    expect(parsePipelineStats(value)).toEqual({ ...value, total_reviewed: 3 })
    expect(() =>
      parsePipelineStats({
        ...value,
        top_rejection_sources: [{ ...value.top_rejection_sources[0], rejection_rate: 100.1 }],
      })
    ).toThrow()
  })
})
