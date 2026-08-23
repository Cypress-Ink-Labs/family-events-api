import { describe, expect, it, vi } from "vitest"
import { buildLlmReviewProvider } from "./provider.js"
import type { LlmReviewConfig } from "./types.js"

// Thin provider test (U29 task brief: "Provider gets a thin test with a stubbed fetch/client").

describe("buildLlmReviewProvider", () => {
  it("calls OpenAI-compatible endpoint and returns parsed response", async () => {
    const config: LlmReviewConfig = {
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
    }

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
    const result = await provider.review(
      {
        systemPrompt: "You are a reviewer.",
        userPrompt: "Review this event.",
        model: "gpt-4o-mini",
      },
      new AbortController().signal
    )

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
})
