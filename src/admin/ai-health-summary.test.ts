import { describe, expect, it } from "vitest"

import {
  providerCredentialsConfigured,
  summarizeAiHealth,
  type AiCallHealthRow,
  type AiFeatureAssignment,
} from "./ai-health-summary.js"

const GROK = "spacexai/grok-4.20-non-reasoning"

function env(values: Record<string, string>) {
  return { get: (name: string) => values[name] }
}

function assignment(
  feature: string,
  enabled: boolean,
  provider: string | null = "gateway"
): AiFeatureAssignment {
  return { feature, provider, enabled }
}

function call(overrides: Partial<AiCallHealthRow>): AiCallHealthRow {
  return {
    feature: "tagging",
    provider: "gateway",
    model: GROK,
    last_success_at: null,
    last_failure_at: null,
    last_failure_reason: null,
    ...overrides,
  }
}

const withKey = env({ AI_GATEWAY_API_KEY: "vck_fixture_secret" })

describe("summarizeAiHealth", () => {
  it("is disabled when no AI feature is on", () => {
    const summary = summarizeAiHealth({
      assignments: [assignment("tagging", false), assignment("tag-memory", false)],
      calls: [],
      env: env({}),
    })
    expect(summary.status).toBe("disabled")
  })

  it("reports a missing key for an enabled feature as not configured", () => {
    const summary = summarizeAiHealth({
      assignments: [assignment("tagging", true), assignment("review-memory", true)],
      calls: [],
      env: env({}),
    })
    expect(summary).toMatchObject({
      status: "not_configured",
      gateway_key_configured: false,
      features: [
        { feature: "tagging", credentials_configured: false },
        { feature: "review-memory", credentials_configured: false },
      ],
    })
  })

  it("is unavailable when the latest call failed after the last success", () => {
    const summary = summarizeAiHealth({
      assignments: [assignment("tagging", true)],
      calls: [
        call({
          last_success_at: "2026-10-26T09:00:00.000Z",
          last_failure_at: "2026-10-26T10:00:00.000Z",
          last_failure_reason: "unauthorized",
        }),
        call({ feature: "embeddings", last_success_at: "2026-10-26T09:30:00.000Z" }),
      ],
      env: withKey,
    })
    expect(summary).toMatchObject({
      status: "unavailable",
      gateway_key_configured: true,
      last_failure: {
        feature: "tagging",
        provider: "gateway",
        reason: "unauthorized",
        at: "2026-10-26T10:00:00.000Z",
      },
      last_success_at: "2026-10-26T09:30:00.000Z",
    })
  })

  it("recovers once a later call succeeds", () => {
    const summary = summarizeAiHealth({
      assignments: [assignment("tagging", true)],
      calls: [
        call({
          last_success_at: "2026-10-26T11:00:00.000Z",
          last_failure_at: "2026-10-26T10:00:00.000Z",
          last_failure_reason: "timeout",
        }),
      ],
      env: withKey,
    })
    expect(summary).toMatchObject({ status: "available", last_failure: null })
  })

  it("ignores failures from a disabled feature or a replaced provider", () => {
    const summary = summarizeAiHealth({
      assignments: [assignment("tagging", true), assignment("event-review", false)],
      calls: [
        call({
          provider: "openai",
          model: "gpt-5.4-nano",
          last_failure_at: "2026-10-26T10:00:00.000Z",
          last_failure_reason: "unauthorized",
        }),
        call({
          feature: "event-review",
          last_failure_at: "2026-10-26T10:00:00.000Z",
          last_failure_reason: "rate_limited",
        }),
      ],
      env: withKey,
    })
    expect(summary).toMatchObject({ status: "unknown", last_failure: null })
  })

  it("never returns key values", () => {
    const summary = summarizeAiHealth({
      assignments: [assignment("tagging", true), assignment("parent-tips", true, "openai")],
      calls: [],
      env: env({ AI_GATEWAY_API_KEY: "vck_fixture_secret", OPENAI_API_KEY: "sk-fixture-secret" }),
    })
    expect(JSON.stringify(summary)).not.toMatch(/vck_fixture_secret|sk-fixture-secret/)
  })
})

describe("providerCredentialsConfigured", () => {
  it("checks the variable each provider needs", () => {
    expect(providerCredentialsConfigured("gateway", withKey)).toBe(true)
    expect(providerCredentialsConfigured("gateway", env({ AI_GATEWAY_API_KEY: "  " }))).toBe(false)
    expect(providerCredentialsConfigured("openai", env({ AI_API_KEY: "k" }))).toBe(true)
    expect(providerCredentialsConfigured("openai", withKey)).toBe(false)
    expect(providerCredentialsConfigured("ollama", env({ AI_BASE_URL: "http://ollama" }))).toBe(
      true
    )
    expect(providerCredentialsConfigured(null, withKey)).toBe(false)
  })
})
