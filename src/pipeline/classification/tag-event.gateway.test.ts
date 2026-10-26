import { APICallError } from "ai"
import type * as AiSdk from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setAiOutcomeRecorder, type AiCallOutcome } from "../ai-health.js"
import { DEFAULT_GATEWAY_MODEL } from "../llm-gateway.js"
import { resolveClassification, type TagEventInput } from "./tag-event.js"

const gateway = vi.hoisted(() => ({
  languageModel: vi.fn(),
  apiKeys: [] as Array<string | undefined>,
}))

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiSdk>()
  return {
    ...actual,
    createGateway: (settings: { apiKey?: string }) => {
      gateway.apiKeys.push(settings.apiKey)
      return { languageModel: gateway.languageModel, embeddingModel: vi.fn() }
    },
  }
})

const usage = {
  inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
}
const tags = [
  { id: "tag-outdoor", slug: "outdoor", name: "Outdoor" },
  { id: "tag-free", slug: "free", name: "Free" },
]
const input: TagEventInput = {
  eventId: "evt-1",
  sourceRunId: null,
  triggerType: "import",
  traceStartedAt: 0,
  title: "Free outdoor story time",
  description: "Bring a blanket to the park",
  currentEvent: null,
}
const grokAssignment = { modelId: DEFAULT_GATEWAY_MODEL, provider: "gateway", enabled: true }

describe("tag classification through the AI Gateway", () => {
  const outcomes: AiCallOutcome[] = []

  beforeEach(() => {
    outcomes.length = 0
    gateway.apiKeys.length = 0
    gateway.languageModel.mockReset()
    setAiOutcomeRecorder(async (outcome) => {
      outcomes.push(outcome)
    })
    vi.stubEnv("AI_GATEWAY_API_KEY", "vck_test_key")
    vi.stubEnv("AI_PROVIDER", "")
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("live provider calls are not allowed in tests")))
    )
  })

  afterEach(() => {
    setAiOutcomeRecorder(null)
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("classifies with the assigned Grok model and the single gateway key", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              tags: [{ slug: "outdoor", confidence: 0.92, reason: "park" }],
              age_min: 2,
              age_max: 6,
              reasoning_summary: "Outdoor story time",
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    })
    gateway.languageModel.mockReturnValue(model)

    const result = await resolveClassification(input, tags, grokAssignment)

    expect(gateway.apiKeys).toEqual(["vck_test_key"])
    expect(gateway.languageModel).toHaveBeenCalledWith(DEFAULT_GATEWAY_MODEL)
    expect(result.classification).toMatchObject({
      provider: "gateway",
      model: DEFAULT_GATEWAY_MODEL,
      status: "success",
      tags: [expect.objectContaining({ slug: "outdoor" })],
    })
    expect(result.llmUsage).toMatchObject({ promptTokens: 40, completionTokens: 10 })
    await vi.waitFor(() =>
      expect(outcomes).toEqual([
        { feature: "tagging", provider: "gateway", model: DEFAULT_GATEWAY_MODEL, failure: null },
      ])
    )
  })

  it("falls back to keywords and records the failure when the key is rejected", async () => {
    gateway.languageModel.mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: () =>
          Promise.reject(
            new APICallError({
              message: "Invalid API key",
              url: "https://ai-gateway.vercel.sh/v1/ai/language-model",
              requestBodyValues: {},
              statusCode: 401,
              isRetryable: false,
            })
          ),
      })
    )

    const result = await resolveClassification(input, tags, grokAssignment)

    expect(result.classification).toMatchObject({ provider: "gateway", status: "fallback" })
    expect(result.classification.tags.map((tag) => tag.slug)).toContain("free")
    expect(result.llmUsage).toBeNull()
    await vi.waitFor(() => expect(outcomes[0]?.failure).toBe("unauthorized"))
  })

  it("uses keywords without a provider call when no gateway key is set", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "")

    const result = await resolveClassification(input, tags, grokAssignment)

    expect(result.classification).toMatchObject({ status: "fallback" })
    expect(gateway.languageModel).not.toHaveBeenCalled()
    expect(outcomes).toEqual([])
  })
})
