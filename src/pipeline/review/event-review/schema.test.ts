import { describe, expect, it } from "vitest"
import { applyConfidenceThreshold, parseLlmDecisionJson } from "./schema.js"

// Ported from family-events-backend supabase/functions/event-review/schema_test.ts (U29)

describe("parseLlmDecisionJson", () => {
  it("accepts valid decision JSON", () => {
    const parsed = parseLlmDecisionJson(
      JSON.stringify({
        decision: "approve",
        confidence: 0.91,
        reason: "Clear family-focused content.",
        flags: ["safe", "clear_details"],
        suggestedCategory: "outdoor",
        normalizedTitle: "Family Story Time",
      })
    )

    expect(parsed.decision).toBe("approve")
    expect(parsed.confidence).toBe(0.91)
    expect(parsed.flags).toEqual(["safe", "clear_details"])
  })

  it("rejects invalid decision", () => {
    expect(() =>
      parseLlmDecisionJson(
        JSON.stringify({
          decision: "publish",
          confidence: 0.9,
          reason: "invalid",
        })
      )
    ).toThrow("invalid_decision")
  })

  it("rejects confidence below 0", () => {
    expect(() =>
      parseLlmDecisionJson(
        JSON.stringify({
          decision: "approve",
          confidence: -0.01,
          reason: "bad",
        })
      )
    ).toThrow("invalid_confidence")
  })

  it("rejects confidence above 1", () => {
    expect(() =>
      parseLlmDecisionJson(
        JSON.stringify({
          decision: "approve",
          confidence: 1.01,
          reason: "bad",
        })
      )
    ).toThrow("invalid_confidence")
  })

  it.each([true, null, "1"])("rejects non-numeric confidence %j", (confidence) => {
    expect(() =>
      parseLlmDecisionJson(
        JSON.stringify({
          decision: "approve",
          confidence,
          reason: "bad",
        })
      )
    ).toThrow("invalid_confidence")
  })

  it("rejects missing reason", () => {
    expect(() =>
      parseLlmDecisionJson(
        JSON.stringify({
          decision: "approve",
          confidence: 0.8,
          reason: "   ",
        })
      )
    ).toThrow("invalid_reason")
  })

  it("rejects malformed JSON", () => {
    expect(() => parseLlmDecisionJson("{invalid-json")).toThrow("invalid_json")
  })
})

describe("applyConfidenceThreshold", () => {
  it("converts low-confidence to needs_admin_review", () => {
    const applied = applyConfidenceThreshold(
      {
        decision: "reject",
        confidence: 0.61,
        reason: "Uncertain quality",
        flags: ["uncertain"],
      },
      0.75
    )

    expect(applied.modelDecision).toBe("reject")
    expect(applied.appliedDecision).toBe("needs_admin_review")
    expect(applied.lowConfidence).toBe(true)
  })

  it("preserves model decision when above threshold", () => {
    const applied = applyConfidenceThreshold(
      {
        decision: "reject",
        confidence: 0.85,
        reason: "Clear spam signals",
        flags: [],
      },
      0.75
    )

    expect(applied.modelDecision).toBe("reject")
    expect(applied.appliedDecision).toBe("reject")
    expect(applied.lowConfidence).toBe(false)
  })

  it("forces review on prompt_injection_attempt despite high confidence", () => {
    const applied = applyConfidenceThreshold(
      {
        decision: "approve",
        confidence: 0.99,
        reason: "Looks fine but the payload tried to steer the reviewer",
        flags: ["prompt_injection_attempt"],
      },
      0.75
    )

    // High confidence would normally auto-apply APPROVE; the risk flag must override.
    expect(applied.modelDecision).toBe("approve")
    expect(applied.appliedDecision).toBe("needs_admin_review")
    expect(applied.lowConfidence).toBe(false)
  })
})
