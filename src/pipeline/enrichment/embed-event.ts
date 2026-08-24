// OpenAI embeddings pipeline: embeds an event's title + description and
// upserts the resulting vector via the EmbedEventDb seam.
// Ported from family-events-backend supabase/functions/embed-event/handler.ts
// (`buildEmbeddingInput`, `generateEmbedding`, `storeEmbedding`) (U29).
// Deviations:
// - HTTP transport + response validation moved into `postOpenAiEmbedding`
//   (../llm-openai.ts), mirroring the postOpenAiChatCompletion split already
//   established for tag-event/reviewer. `embedEvent` here only maps the
//   HTTP-failure case (`OpenAiEmbeddingHttpError`) to `EmbedEventUpstreamError`
//   — exactly matching legacy `generateEmbedding`, which threw
//   `EmbedEventUpstreamError` solely for non-2xx responses. The
//   dimension-mismatch branch still throws a plain, unwrapped `Error` (legacy
//   never wrapped that case either).
// - `storeEmbedding`'s Supabase upsert (vector-string formatting, created_at
//   stamp, ON CONFLICT (event_id)) becomes the `EmbedEventDb.upsertEventEmbedding`
//   seam; the repository implementation is a separate task (worker purity:
//   no pg here).
// - The Deno HTTP handler shell (CORS, service-role auth, request body
//   parsing, Sentry capture, processing_ms/stored response) was dropped,
//   matching how tag-event.ts / process-source.ts already dropped their own
//   HTTP shells.

import { OpenAiEmbeddingHttpError, postOpenAiEmbedding } from "../llm-openai.js"

export const EMBEDDING_MODEL = "text-embedding-3-small"
export const EMBEDDING_DIMENSIONS = 1536

/**
 * Cap combined text length to ~2000 chars before sending to the embeddings
 * API. text-embedding-3-small supports 8191 tokens, but shorter text is
 * cheaper and still captures the semantic essence for similarity matching.
 */
export const MAX_INPUT_CHARS = 2000

const DEFAULT_BASE_URL = "https://api.openai.com/v1"

export interface EmbedEventDb {
  /** Upsert into public.event_embeddings ON CONFLICT (event_id) — legacy embed-event/handler.ts storeEmbedding. */
  upsertEventEmbedding(eventId: string, embedding: number[], model: string): Promise<void>
}

export interface EmbedEventInput {
  eventId: string
  title: string
  description: string | null
}

export interface EmbedEventDependencies {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class EmbedEventUpstreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EmbedEventUpstreamError"
  }
}

/**
 * Combine title + description into a single embedding input, capped to
 * MAX_INPUT_CHARS. Ported verbatim from legacy `buildEmbeddingInput`.
 */
export function buildEmbeddingInput(title: string, description: string | null): string {
  const parts = [title.trim()]
  if (description) {
    parts.push(description.trim())
  }
  const combined = parts.join("\n\n")
  return combined.slice(0, MAX_INPUT_CHARS)
}

/**
 * Embed one event and upsert the resulting vector. Mirrors legacy
 * `embedEvent` minus the processing-ms/stored response shape and logging,
 * which belong to a future caller (see file-level deviations note).
 */
export async function embedEvent(
  db: EmbedEventDb,
  input: EmbedEventInput,
  deps: EmbedEventDependencies
): Promise<void> {
  const text = buildEmbeddingInput(input.title, input.description)

  let embedding: number[]
  try {
    embedding = await postOpenAiEmbedding({
      baseUrl: deps.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: deps.apiKey,
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
      timeoutMs: deps.timeoutMs,
      fetchImpl: deps.fetchImpl,
    })
  } catch (err) {
    if (err instanceof OpenAiEmbeddingHttpError) {
      throw new EmbedEventUpstreamError(err.message)
    }
    throw err
  }

  await db.upsertEventEmbedding(input.eventId, embedding, EMBEDDING_MODEL)
}
