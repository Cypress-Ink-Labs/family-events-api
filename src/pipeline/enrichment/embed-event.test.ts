import { describe, expect, it } from "vitest"

import {
  buildEmbeddingInput,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embedEvent,
  EmbedEventUpstreamError,
  type EmbedEventDb,
} from "./embed-event.js"

// Ported from family-events-backend supabase/functions/embed-event/handler_test.ts (U29).

class FakeEmbedEventDb implements EmbedEventDb {
  upserts: Array<{ eventId: string; embedding: number[]; model: string }> = []

  upsertEventEmbedding(eventId: string, embedding: number[], model: string): Promise<void> {
    this.upserts.push({ eventId, embedding, model })
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

function okEmbeddingResponse(vector: number[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ embedding: vector, index: 0 }],
      model: EMBEDDING_MODEL,
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }),
  }
}

describe("buildEmbeddingInput", () => {
  it("builds input as title + blank line + description, truncated to 2000 chars", () => {
    expect(buildEmbeddingInput("T", "D")).toBe("T\n\nD")
    expect(buildEmbeddingInput("T", null)).toBe("T")
    expect(buildEmbeddingInput("T", "x".repeat(3000)).length).toBe(2000)
  })
})

describe("embedEvent", () => {
  it("posts model/input/dimensions and upserts the validated 1536-dim vector", async () => {
    const vector = Array(EMBEDDING_DIMENSIONS).fill(0.5)
    const { fetchImpl, calls } = fakeFetch(async () => okEmbeddingResponse(vector))
    const db = new FakeEmbedEventDb()

    await embedEvent(
      db,
      { eventId: "event-1", title: "Story Time", description: "Books and songs" },
      { apiKey: "sk-test", fetchImpl }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer sk-test" })
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      model: EMBEDDING_MODEL,
      input: "Story Time\n\nBooks and songs",
      dimensions: EMBEDDING_DIMENSIONS,
    })
    expect(db.upserts).toEqual([{ eventId: "event-1", embedding: vector, model: EMBEDDING_MODEL }])
  })

  it("throws EmbedEventUpstreamError on non-2xx with body truncated to 200 chars", async () => {
    const longBody = "x".repeat(300)
    const { fetchImpl } = fakeFetch(async () => ({
      ok: false,
      status: 500,
      text: async () => longBody,
    }))
    const db = new FakeEmbedEventDb()

    const rejection = embedEvent(
      db,
      { eventId: "event-1", title: "T", description: null },
      { apiKey: "sk-test", fetchImpl }
    )

    await expect(rejection).rejects.toBeInstanceOf(EmbedEventUpstreamError)
    await expect(rejection).rejects.toThrow(
      `OpenAI embeddings failed (500): ${longBody.slice(0, 200)}`
    )
    expect(db.upserts).toHaveLength(0)
  })

  it("throws when the response vector length is not 1536", async () => {
    const { fetchImpl } = fakeFetch(async () => okEmbeddingResponse([0.1, 0.2, 0.3]))
    const db = new FakeEmbedEventDb()

    const rejection = embedEvent(
      db,
      { eventId: "event-1", title: "T", description: null },
      { apiKey: "sk-test", fetchImpl }
    )

    await expect(rejection).rejects.not.toBeInstanceOf(EmbedEventUpstreamError)
    await expect(rejection).rejects.toThrow("OpenAI returned unexpected embedding dimensions: 3")
    expect(db.upserts).toHaveLength(0)
  })
})
