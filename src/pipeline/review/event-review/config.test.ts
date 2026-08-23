import { describe, expect, it } from "vitest"
import { resolveLlmReviewConfig } from "./config.js"
import type { EnvReader } from "./config.js"

// Ported from family-events-backend supabase/functions/event-review/config_test.ts (U29)

function env(values: Record<string, string | undefined>): EnvReader {
  return {
    get(key: string) {
      return values[key]
    },
  }
}

describe("resolveLlmReviewConfig", () => {
  it("defaults are production-safe", () => {
    const config = resolveLlmReviewConfig(env({}))

    expect(config.enabled).toBe(false)
    expect(config.confidenceThreshold).toBe(0.75)
    expect(config.timeoutMs).toBe(30_000)
    expect(config.maxAttempts).toBe(3)
    expect(config.persistRawResponse).toBe(false)
  })

  it("invalid threshold fails closed", () => {
    const config = resolveLlmReviewConfig(
      env({
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_PROVIDER: "openai-compatible",
        LLM_REVIEW_BASE_URL: "https://example.com/v1",
        LLM_REVIEW_MODEL: "gpt-4o-mini",
        LLM_REVIEW_API_KEY: "secret",
        LLM_REVIEW_CONFIDENCE_THRESHOLD: "2",
      })
    )

    expect(config.enabled).toBe(true)
    expect(config.valid).toBe(false)
    expect(config.invalidReason).toBe("invalid_confidence_threshold")
  })

  it("missing model/api key while enabled fails closed", () => {
    const missingModel = resolveLlmReviewConfig(
      env({
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_BASE_URL: "https://example.com/v1",
        LLM_REVIEW_API_KEY: "secret",
      })
    )
    expect(missingModel.valid).toBe(false)
    expect(missingModel.invalidReason).toBe("missing_model")

    const missingKey = resolveLlmReviewConfig(
      env({
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_BASE_URL: "https://example.com/v1",
        LLM_REVIEW_MODEL: "gpt-4o-mini",
      })
    )
    expect(missingKey.valid).toBe(false)
    expect(missingKey.invalidReason).toBe("missing_api_key")
  })

  it("invalid timeout or attempts fail closed", () => {
    const invalidTimeout = resolveLlmReviewConfig(
      env({
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_BASE_URL: "https://example.com/v1",
        LLM_REVIEW_MODEL: "gpt-4o-mini",
        LLM_REVIEW_API_KEY: "secret",
        LLM_REVIEW_TIMEOUT_MS: "nope",
      })
    )
    expect(invalidTimeout.valid).toBe(false)
    expect(invalidTimeout.invalidReason).toBe("invalid_timeout")

    const invalidAttempts = resolveLlmReviewConfig(
      env({
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_BASE_URL: "https://example.com/v1",
        LLM_REVIEW_MODEL: "gpt-4o-mini",
        LLM_REVIEW_API_KEY: "secret",
        LLM_REVIEW_MAX_ATTEMPTS: "0",
      })
    )
    expect(invalidAttempts.valid).toBe(false)
    expect(invalidAttempts.invalidReason).toBe("invalid_max_attempts")
  })

  it("reads AI_* fallbacks", () => {
    const config = resolveLlmReviewConfig(
      env({
        LLM_REVIEW_ENABLED: "true",
        AI_PROVIDER: "openai-compatible",
        AI_BASE_URL: "https://ai.example.com/v1",
        AI_MODEL: "model-x",
        AI_API_KEY: "ai-key",
      })
    )

    expect(config.provider).toBe("openai-compatible")
    expect(config.baseUrl).toBe("https://ai.example.com/v1")
    expect(config.model).toBe("model-x")
    expect(config.apiKey).toBe("ai-key")
    expect(config.valid).toBe(true)
  })

  it("uses dbOverrides when provided", () => {
    const envReader = env({
      LLM_REVIEW_ENABLED: "false",
      LLM_REVIEW_BASE_URL: "https://api.openai.com/v1",
      LLM_REVIEW_API_KEY: "sk-test",
      LLM_REVIEW_MODEL: "gpt-4o-mini",
    })

    const config = resolveLlmReviewConfig(envReader, { model: "gpt-4.1", enabled: true })

    expect(config.model).toBe("gpt-4.1")
    expect(config.enabled).toBe(true)
  })

  it("uses env when dbOverrides is null", () => {
    const envReader = env({
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_BASE_URL: "https://api.openai.com/v1",
      LLM_REVIEW_API_KEY: "sk-test",
      LLM_REVIEW_MODEL: "gpt-4o-mini",
    })

    const config = resolveLlmReviewConfig(envReader, null)

    expect(config.model).toBe("gpt-4o-mini")
    expect(config.enabled).toBe(true)
  })
})
