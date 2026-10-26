import { afterEach, describe, expect, it, vi } from "vitest"

import {
  classifyAiFailure,
  recordAiOutcome,
  setAiOutcomeRecorder,
  withAiTelemetry,
  type AiCallOutcome,
} from "./ai-health.js"
import { OpenAiChatCompletionHttpError } from "./llm-openai.js"

function named(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("fixture"), { name, ...extra })
}

describe("classifyAiFailure", () => {
  it.each([
    [new OpenAiChatCompletionHttpError("openai failed", 401), "unauthorized"],
    [new OpenAiChatCompletionHttpError("openai failed", 403), "unauthorized"],
    [named("AI_APICallError", { statusCode: 429 }), "rate_limited"],
    [named("AI_APICallError", { statusCode: 504 }), "timeout"],
    [named("AI_APICallError", { statusCode: 500 }), "provider_error"],
    [named("AI_APICallError"), "provider_error"],
    [named("GatewayAuthenticationError"), "unauthorized"],
    [named("GatewayRateLimitError"), "rate_limited"],
    [named("GatewayInternalServerError"), "provider_error"],
    [named("AbortError"), "timeout"],
    [named("TimeoutError"), "timeout"],
    [new TypeError("fetch failed"), "provider_error"],
  ])("classifies %s", (error, reason) => {
    expect(classifyAiFailure(error)).toBe(reason)
  })

  it("does not mark AI unavailable when the provider answered with unusable content", () => {
    expect(classifyAiFailure(new SyntaxError("Unexpected token"))).toBeNull()
    expect(classifyAiFailure(new Error("returned an empty response"))).toBeNull()
    expect(classifyAiFailure("not an error")).toBeNull()
  })
})

describe("AI call telemetry", () => {
  afterEach(() => setAiOutcomeRecorder(null))

  it("records success and classified failure without changing the call result", async () => {
    const outcomes: AiCallOutcome[] = []
    setAiOutcomeRecorder(async (outcome) => {
      outcomes.push(outcome)
    })
    const telemetry = { feature: "tagging", provider: "gateway", model: "m" } as const

    await expect(withAiTelemetry(telemetry, async () => "ok")).resolves.toBe("ok")
    const failure = new OpenAiChatCompletionHttpError("failed", 401)
    await expect(withAiTelemetry(telemetry, () => Promise.reject(failure))).rejects.toBe(failure)

    await vi.waitFor(() =>
      expect(outcomes.map((outcome) => outcome.failure)).toEqual([null, "unauthorized"])
    )
  })

  it("skips recording when no telemetry or recorder is set", async () => {
    const recorder = vi.fn(async () => undefined)
    await expect(withAiTelemetry(undefined, async () => 1)).resolves.toBe(1)
    setAiOutcomeRecorder(recorder)
    await withAiTelemetry(undefined, async () => 1)
    expect(recorder).not.toHaveBeenCalled()
  })

  it("never lets a failed health write reach the pipeline", async () => {
    setAiOutcomeRecorder(() => Promise.reject(new Error("database down")))
    expect(() =>
      recordAiOutcome({ feature: "embeddings", provider: "gateway", model: "m", failure: null })
    ).not.toThrow()
    await new Promise((resolve) => setImmediate(resolve))
  })
})
