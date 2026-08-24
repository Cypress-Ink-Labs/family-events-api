import { describe, expect, it } from "vitest"

import type { EnvReader } from "../llm-config.js"
import { PARENT_TIPS_JSON_SCHEMA } from "./parent-tips-prompt.js"
import {
  generateParentTipsForEvent,
  resolveParentTipsAiConfig,
  type ParentTip,
  type ParentTipsCandidate,
  type ParentTipsDb,
  type ParentTipsLlmConfig,
} from "./generate-parent-tips.js"

// Ported from family-events-backend supabase/functions/generate-parent-tips/handler.ts
// (`resolveAiConfig` :113-145, `generateWithLlm` :218-283) (U29). No prior Deno
// test existed for this function upstream; assertions are new, written against
// the ported behavior per the task-5 brief.

function fakeEnv(vars: Record<string, string>): EnvReader {
  return { get: (name) => vars[name] }
}

describe("resolveParentTipsAiConfig", () => {
  it("uses the DB model when it is in the allowlist", () => {
    const config = resolveParentTipsAiConfig(
      { modelId: "gpt-4.1-mini", provider: "openai", enabled: true },
      fakeEnv({ AI_API_KEY: "sk-test" })
    )
    expect(config.model).toBe("gpt-4.1-mini")
    expect(config.provider).toBe("openai")
    expect(config.configured).toBe(true)
  })

  it("falls back to DEFAULT_OPENAI_MODEL for a DB model missing from the legacy allowlist (deviation #6: ALLOWED_OPENAI_MODELS is a verbatim, deliberately stale port that lacks the gpt-5.4* ids seeded in approved_ai_models — intentional for U33 cutover parity)", () => {
    const config = resolveParentTipsAiConfig(
      { modelId: "gpt-5.4-nano", provider: "openai", enabled: true },
      fakeEnv({ AI_API_KEY: "sk-test" })
    )
    expect(config.model).toBe("gpt-4.1-nano")
  })

  it("unconfigures (but keeps the resolved model) when the feature is disabled", () => {
    const config = resolveParentTipsAiConfig(
      { modelId: "gpt-4.1-mini", provider: "openai", enabled: false },
      fakeEnv({ AI_API_KEY: "sk-test" })
    )
    expect(config.enabled).toBe(false)
    expect(config.configured).toBe(false)
    expect(config.model).toBe("gpt-4.1-mini")
  })

  it("does not require an api key for the ollama provider", () => {
    const config = resolveParentTipsAiConfig(
      { modelId: "qwen3:1.7b", provider: "ollama", enabled: true },
      fakeEnv({ AI_BASE_URL: "http://localhost:11434/v1" })
    )
    expect(config.provider).toBe("ollama")
    expect(config.apiKey).toBe("ollama")
    expect(config.configured).toBe(true)
  })

  it("returns a fully unconfigured config when the feature row is missing", () => {
    const config = resolveParentTipsAiConfig(null)
    expect(config).toEqual({
      provider: "openai",
      model: "gpt-4.1-nano",
      baseUrl: "",
      apiKey: null,
      enabled: false,
      configured: false,
    })
  })
})

class FakeParentTipsDb implements ParentTipsDb {
  updates: Array<{
    eventId: string
    tips: ParentTip[]
    provider: string
    model: string
    promptVersion: string
  }> = []
  attempts: string[] = []

  loadParentTipsFeatureConfig(): Promise<{
    modelId: string | null
    provider: string | null
    enabled: boolean
  } | null> {
    throw new Error("not used in this test")
  }

  listEventsNeedingParentTips(): Promise<ParentTipsCandidate[]> {
    throw new Error("not used in this test")
  }

  updateEventParentTips(
    eventId: string,
    tips: ParentTip[],
    provider: string,
    model: string,
    promptVersion: string
  ): Promise<void> {
    this.updates.push({ eventId, tips, provider, model, promptVersion })
    return Promise.resolve()
  }

  markEnrichmentAttempt(eventId: string): Promise<void> {
    this.attempts.push(eventId)
    return Promise.resolve()
  }
}

interface FetchCall {
  url: string | URL | Request
  init?: RequestInit
}

function fakeFetch(handler: (call: FetchCall) => Promise<unknown>): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function chatResponse(tipsPayload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(tipsPayload) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  }
}

function baseCandidate(overrides: Partial<ParentTipsCandidate> = {}): ParentTipsCandidate {
  return {
    eventId: "event-1",
    title: "Story Time",
    description: "Books and songs at the library",
    ageMin: 2,
    ageMax: 6,
    isOutdoor: false,
    venueName: "Main Library",
    startDatetime: "2026-09-01T15:00:00Z",
    tags: ["storytime", "library"],
    ...overrides,
  }
}

function baseConfig(overrides: Partial<ParentTipsLlmConfig> = {}): ParentTipsLlmConfig {
  return {
    provider: "openai",
    model: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    enabled: true,
    configured: true,
    ...overrides,
  }
}

describe("generateParentTipsForEvent", () => {
  it("sends temperature 0.2 and a strict JSON-schema response_format on the openai path", async () => {
    const { fetchImpl, calls } = fakeFetch(async () =>
      chatResponse({
        tips: [{ category: "arrival", text: "Arrive 15 minutes early for parking." }],
      })
    )
    const db = new FakeParentTipsDb()

    const result = await generateParentTipsForEvent(db, baseCandidate(), baseConfig(), {
      fetchImpl,
    })

    expect(result.status).toBe("generated")
    const body = JSON.parse(calls[0]?.init?.body as string)
    expect(body.temperature).toBe(0.2)
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "parent_tips", strict: true, schema: PARENT_TIPS_JSON_SCHEMA },
    })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it("sends json_object response_format and reasoning_effort none on the ollama path", async () => {
    const { fetchImpl, calls } = fakeFetch(async () =>
      chatResponse({ tips: [{ category: "bring", text: "Bring a water bottle for the walk." }] })
    )
    const db = new FakeParentTipsDb()
    const config = baseConfig({
      provider: "ollama",
      model: "qwen3:1.7b",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
    })

    await generateParentTipsForEvent(db, baseCandidate(), config, { fetchImpl })

    const body = JSON.parse(calls[0]?.init?.body as string)
    expect(body.response_format).toEqual({ type: "json_object" })
    expect(body.reasoning_effort).toBe("none")
  })

  it("filters to allowed categories, dedupes by category, and caps at 3 tips (in model order)", async () => {
    const { fetchImpl } = fakeFetch(async () =>
      chatResponse({
        tips: [
          { category: "arrival", text: "Arrive early for parking." },
          { category: "bogus-category", text: "Should be dropped." },
          { category: "bring", text: "" },
          { category: "arrival", text: "Duplicate category dropped." },
          { category: "timing", text: "Doors open at 3pm sharp." },
          { category: "weather", text: "Bring a jacket, it's outdoors." },
          { category: "accessibility", text: "Ramp access at the side door." },
        ],
      })
    )
    const db = new FakeParentTipsDb()

    const result = await generateParentTipsForEvent(db, baseCandidate(), baseConfig(), {
      fetchImpl,
    })

    expect(result.status).toBe("generated")
    if (result.status === "generated") {
      expect(result.tips).toEqual([
        { category: "arrival", tip: "Arrive early for parking." },
        { category: "timing", tip: "Doors open at 3pm sharp." },
        { category: "weather", tip: "Bring a jacket, it's outdoors." },
      ])
    }
  })

  it("returns failed with no DB write when zero valid tips survive filtering", async () => {
    const { fetchImpl } = fakeFetch(async () =>
      chatResponse({ tips: [{ category: "bogus-category", text: "x" }] })
    )
    const db = new FakeParentTipsDb()

    const result = await generateParentTipsForEvent(db, baseCandidate(), baseConfig(), {
      fetchImpl,
    })

    expect(result).toEqual({ status: "failed", error: "model returned no valid parent tips" })
    expect(db.updates).toHaveLength(0)
  })

  it("calls updateEventParentTips with LLM_PARENT_TIPS_PROMPT_VERSION on success", async () => {
    const { fetchImpl } = fakeFetch(async () =>
      chatResponse({ tips: [{ category: "arrival", text: "Arrive early." }] })
    )
    const db = new FakeParentTipsDb()

    const result = await generateParentTipsForEvent(db, baseCandidate(), baseConfig(), {
      fetchImpl,
    })

    expect(result.status).toBe("generated")
    expect(db.updates).toEqual([
      {
        eventId: "event-1",
        tips: [{ category: "arrival", tip: "Arrive early." }],
        provider: "openai",
        model: "gpt-4.1-mini",
        promptVersion: "parent-tips-v1",
      },
    ])
  })

  it("returns failed with no DB write on upstream HTTP failure", async () => {
    const { fetchImpl } = fakeFetch(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
    }))
    const db = new FakeParentTipsDb()

    const result = await generateParentTipsForEvent(db, baseCandidate(), baseConfig(), {
      fetchImpl,
    })

    expect(result.status).toBe("failed")
    expect(db.updates).toHaveLength(0)
    expect(db.attempts).toHaveLength(0)
  })
})
