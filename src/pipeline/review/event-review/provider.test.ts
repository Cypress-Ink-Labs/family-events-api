import { describe, expect, it, vi } from "vitest"
import { reviewEventWithLlm } from "./reviewer.js"
import { buildLlmReviewProvider } from "./provider.js"
import type { LlmReviewConfig } from "./types.js"

// Thin provider test (U29 task brief: "Provider gets a thin test with a stubbed fetch/client").

function reviewConfig(overrides: Partial<LlmReviewConfig> = {}): LlmReviewConfig {
  return {
    enabled: true,
    provider: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4o-mini",
    apiKey: "sk-test-key",
    promptVersion: "event-review-v2",
    confidenceThreshold: 0.75,
    timeoutMs: 30_000,
    maxAttempts: 3,
    retryBaseMs: 60_000,
    persistRawResponse: false,
    valid: true,
    invalidReason: null,
    ...overrides,
  }
}

const providerInput = {
  systemPrompt: "You are a reviewer.",
  userPrompt: "Review this event.",
  model: "gpt-4o-mini",
}

describe("buildLlmReviewProvider", () => {
  it("calls OpenAI-compatible endpoint and returns parsed response", async () => {
    const config = reviewConfig()

    const mockFetch = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: "approve",
                  confidence: 0.9,
                  reason: "Clear family event",
                }),
              },
            },
          ],
        }),
      })
    ) as unknown as typeof fetch

    const provider = buildLlmReviewProvider(config, mockFetch)
    const result = await provider.review(providerInput, new AbortController().signal)

    expect(result.provider).toBe("openai-compatible")
    expect(result.model).toBe("gpt-4o-mini")
    expect(result.rawText).toContain("approve")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test-key",
        }),
      })
    )
  })

  it("passes an already-aborted caller signal through to fetch", async () => {
    const caller = new AbortController()
    caller.abort(new Error("caller cancelled"))
    const mockFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.signal?.aborted) throw new Error("caller signal was not aborted")
      return Promise.reject(init.signal.reason)
    }) as unknown as typeof fetch

    const provider = buildLlmReviewProvider(reviewConfig(), mockFetch)

    await expect(provider.review(providerInput, caller.signal)).rejects.toThrow("caller cancelled")
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it("stops an active fetch when the caller aborts", async () => {
    const caller = new AbortController()
    const mockFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const requestSignal = init?.signal
      if (!requestSignal) throw new Error("request signal missing")
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true })
        queueMicrotask(() => {
          if (!requestSignal.aborted) reject(new Error("request remained active"))
        })
      })
    }) as unknown as typeof fetch
    const provider = buildLlmReviewProvider(reviewConfig(), mockFetch)

    const pending = provider.review(providerInput, caller.signal)
    caller.abort(new Error("caller cancelled"))

    await expect(pending).rejects.toThrow("caller cancelled")
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it("classifies non-2xx provider responses as provider_http_error", async () => {
    const config = reviewConfig()
    const mockFetch = vi.fn(async () =>
      Promise.resolve({
        ok: false,
        status: 429,
        text: async () => "rate limited",
      })
    ) as unknown as typeof fetch
    const provider = buildLlmReviewProvider(config, mockFetch)

    const result = await reviewEventWithLlm(
      {
        eventId: "event-1",
        title: "Family Story Time",
        description: "Books and songs",
        startDatetime: "2026-09-01T15:00:00Z",
        endDatetime: null,
        timezone: "America/Chicago",
        venueName: "Main Library",
        address: "301 W Congress St",
        sourceName: "Library Calendar",
        sourceUrl: "https://example.com/events/1",
        category: null,
        tags: [],
      },
      { config, provider }
    )

    expect(result.errorCode).toBe("provider_http_error")
    expect(result.errorMessage).toBe("LLM review (429): rate limited")
  })
})
