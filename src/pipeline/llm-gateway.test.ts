import { APICallError } from "ai"
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setAiOutcomeRecorder, type AiCallOutcome } from "./ai-health.js"
import {
  APPROVED_GATEWAY_MODELS,
  DEFAULT_GATEWAY_MODEL,
  GATEWAY_EMBEDDING_MODEL,
  gatewayReasoning,
  GatewayHttpError,
  generateGatewayEmbedding,
  generateGatewayText,
  resolveGatewayModel,
  type GatewayModels,
} from "./llm-gateway.js"

const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function modelsWith(language: MockLanguageModelV4, embedding?: MockEmbeddingModelV4) {
  const requested: string[] = []
  const models: GatewayModels = {
    languageModel: (id) => {
      requested.push(id)
      return language
    },
    embeddingModel: (id) => {
      requested.push(id)
      return embedding ?? new MockEmbeddingModelV4()
    },
  }
  return { models, requested }
}

function unauthorized(): APICallError {
  return new APICallError({
    message: "Invalid API key sk-should-not-leak",
    url: "https://ai-gateway.vercel.sh/v1/ai/language-model",
    requestBodyValues: {},
    statusCode: 401,
    responseBody: '{"error":"upstream body that must not leak"}',
    isRetryable: false,
  })
}

describe("AI Gateway transport", () => {
  const outcomes: AiCallOutcome[] = []

  beforeEach(() => {
    outcomes.length = 0
    setAiOutcomeRecorder(async (outcome) => {
      outcomes.push(outcome)
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("live provider calls are not allowed in tests")))
    )
  })

  afterEach(() => {
    setAiOutcomeRecorder(null)
    vi.unstubAllGlobals()
  })

  it("defaults to GPT-6 Luna and keeps every approved gateway model selectable", () => {
    expect(DEFAULT_GATEWAY_MODEL).toBe("openai/gpt-6-luna")
    expect([...APPROVED_GATEWAY_MODELS]).toEqual([
      "openai/gpt-6-luna",
      "openai/gpt-6-luna-fast",
      "spacexai/grok-4.20-non-reasoning",
      "spacexai/grok-4.3",
      "spacexai/grok-4.7",
    ])
    for (const model of APPROVED_GATEWAY_MODELS) expect(resolveGatewayModel(model)).toBe(model)
  })

  it("falls back to the default for unapproved, legacy or unprefixed model ids", () => {
    for (const model of [
      "gpt-5.4-nano",
      "gpt-6-luna",
      "openai/gpt-6-luna-batch",
      "openai/gpt-6-luna-decisions",
      "OPENAI/GPT-6-LUNA",
      " openai/gpt-6-luna",
      "",
      null,
      undefined,
    ])
      expect(resolveGatewayModel(model)).toBe(DEFAULT_GATEWAY_MODEL)
  })

  it("turns reasoning off for tagging unless the model cannot, and keeps other features low", () => {
    for (const model of APPROVED_GATEWAY_MODELS) {
      expect(gatewayReasoning("event-review", model)).toBe("low")
      expect(gatewayReasoning("parent-tips", model)).toBe("low")
      expect(gatewayReasoning("source-extraction", model)).toBe("low")
    }
    expect(gatewayReasoning("tagging", "openai/gpt-6-luna")).toBe("none")
    expect(gatewayReasoning("tagging", "openai/gpt-6-luna-fast")).toBe("none")
    expect(gatewayReasoning("tagging", "spacexai/grok-4.20-non-reasoning")).toBe("none")
    expect(gatewayReasoning("tagging", "spacexai/grok-4.3")).toBe("low")
    expect(gatewayReasoning("tagging", "spacexai/grok-4.7")).toBe("low")
  })

  it.each(["openai/gpt-6-luna", "openai/gpt-6-luna-fast"])(
    "sends %s verbatim in JSON mode at the caller's temperature with low reasoning",
    async (model) => {
      const language = new MockLanguageModelV4({
        doGenerate: {
          content: [{ type: "text", text: '{"decision":"approve"}' }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: { total: 9, text: 5, reasoning: 4 },
          },
          warnings: [],
        },
      })
      const { models, requested } = modelsWith(language)

      const result = await generateGatewayText({
        apiKey: "test-key",
        model,
        system: "Return JSON ONLY.",
        prompt: "Event",
        temperature: 0,
        feature: "event-review",
        failureMessagePrefix: "LLM review",
        timeoutMs: 30_000,
        models,
      })

      expect(requested).toEqual([model])
      expect(language.doGenerateCalls).toHaveLength(1)
      const call = language.doGenerateCalls[0]!
      expect(call).toMatchObject({ temperature: 0, responseFormat: { type: "json" } })
      expect(call.responseFormat).not.toHaveProperty("schema")
      expect(call.reasoning).toBe("low")
      expect(call.providerOptions).toBeUndefined()
      expect(call.maxOutputTokens).toBeUndefined()
      expect(result.content).toBe('{"decision":"approve"}')
      expect(result.usage).toMatchObject({ promptTokens: 12, completionTokens: 9, totalTokens: 21 })
      await vi.waitFor(() =>
        expect(outcomes).toEqual([
          { feature: "event-review", provider: "gateway", model, failure: null },
        ])
      )
    }
  )

  it("returns JSON text, usage and a success outcome from one request", async () => {
    const language = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: '{"tags":["outdoor"]}' }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    })
    const { models, requested } = modelsWith(language)

    const result = await generateGatewayText({
      apiKey: "test-key",
      model: DEFAULT_GATEWAY_MODEL,
      system: "Classify.",
      prompt: "Story time",
      temperature: 0.1,
      feature: "tagging",
      failureMessagePrefix: "gateway classification failed",
      models,
    })

    expect(result.content).toBe('{"tags":["outdoor"]}')
    expect(result.usage).toMatchObject({ promptTokens: 12, completionTokens: 5, totalTokens: 17 })
    expect(requested).toEqual([DEFAULT_GATEWAY_MODEL])
    expect(language.doGenerateCalls).toHaveLength(1)
    expect(language.doGenerateCalls[0]).toMatchObject({
      temperature: 0.1,
      responseFormat: { type: "json" },
      reasoning: "none",
    })
    await vi.waitFor(() =>
      expect(outcomes).toEqual([
        { feature: "tagging", provider: "gateway", model: DEFAULT_GATEWAY_MODEL, failure: null },
      ])
    )
  })

  it("reports a rejected key by status only and records it as unauthorized", async () => {
    const language = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(unauthorized()),
    })
    const { models } = modelsWith(language)

    const error = await generateGatewayText({
      apiKey: "test-key",
      model: DEFAULT_GATEWAY_MODEL,
      system: "Review.",
      prompt: "Event",
      temperature: 0,
      feature: "event-review",
      failureMessagePrefix: "gateway review failed",
      models,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(GatewayHttpError)
    expect((error as GatewayHttpError).status).toBe(401)
    expect((error as Error).message).toBe("gateway review failed (401)")
    expect(JSON.stringify(error)).not.toMatch(/sk-should-not-leak|upstream body/)
    expect(language.doGenerateCalls).toHaveLength(1)
    await vi.waitFor(() =>
      expect(outcomes).toEqual([
        {
          feature: "event-review",
          provider: "gateway",
          model: DEFAULT_GATEWAY_MODEL,
          failure: "unauthorized",
        },
      ])
    )
  })

  it("returns non-JSON text for the caller's own parser and fallback", async () => {
    const fenced = '```json\n{"tips":[]}\n```'
    const language = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: fenced }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    })
    const { models } = modelsWith(language)

    const result = await generateGatewayText({
      apiKey: "test-key",
      model: DEFAULT_GATEWAY_MODEL,
      system: "Tips.",
      prompt: "Event",
      temperature: 0.2,
      feature: "parent-tips",
      failureMessagePrefix: "gateway tips failed",
      models,
    })

    expect(result).toMatchObject({ content: fenced, usage: { totalTokens: 17 }, raw: null })
    await vi.waitFor(() => expect(outcomes[0]?.failure).toBeNull())
  })

  it("treats an empty completion as a reachable provider", async () => {
    const language = new MockLanguageModelV4({
      doGenerate: {
        content: [],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    })
    const { models } = modelsWith(language)

    await expect(
      generateGatewayText({
        apiKey: "test-key",
        model: DEFAULT_GATEWAY_MODEL,
        system: "Tips.",
        prompt: "Event",
        temperature: 0.2,
        feature: "parent-tips",
        failureMessagePrefix: "gateway tips failed",
        models,
      })
    ).rejects.toThrow("gateway returned an empty response")
    await vi.waitFor(() => expect(outcomes[0]?.failure).toBeNull())
  })

  it("requests text-embedding-3-small vectors at the stored dimensions", async () => {
    const embedding = new MockEmbeddingModelV4({
      doEmbed: { embeddings: [[0.1, 0.2, 0.3]], warnings: [] },
    })
    const { models, requested } = modelsWith(new MockLanguageModelV4(), embedding)

    await expect(
      generateGatewayEmbedding({ apiKey: "test-key", value: "Story time", dimensions: 3, models })
    ).resolves.toEqual([0.1, 0.2, 0.3])
    expect(requested).toEqual([GATEWAY_EMBEDDING_MODEL])
    expect(embedding.doEmbedCalls[0]).toMatchObject({ values: ["Story time"], dimensions: 3 })
  })

  it("rejects embeddings with the wrong dimensions", async () => {
    const embedding = new MockEmbeddingModelV4({
      doEmbed: { embeddings: [[0.1, 0.2]], warnings: [] },
    })
    const { models } = modelsWith(new MockLanguageModelV4(), embedding)

    await expect(
      generateGatewayEmbedding({ apiKey: "test-key", value: "Story time", dimensions: 3, models })
    ).rejects.toThrow("unexpected embedding dimensions: 2")
  })
})
