// OpenAI-compatible chat-completion POST helper. Ported verbatim from
// family-events-backend supabase/functions/_shared/llm-openai.ts (U28).

export interface ChatCompletionUsage {
  completionTokens: number | null
  finishReason: string | null
  promptTokens: number | null
  totalTokens: number | null
}

export interface ChatCompletionResult {
  content: string
  latencyMs: number
  raw: unknown
  usage: ChatCompletionUsage
}

export interface ChatCompletionOptions {
  apiKey: string
  baseUrl: string
  body: Record<string, unknown>
  fetchImpl?: typeof fetch
  failureMessagePrefix?: string
  providerName?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export class OpenAiChatCompletionHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = "OpenAiChatCompletionHttpError"
  }
}

function readTokenCount(value: unknown): number | null {
  return Number.isFinite(value) ? Number(value) : null
}

export function parseJsonContent(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content)
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  throw new Error("provider_json_content_not_object")
}

export async function postOpenAiChatCompletion(
  options: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const startedAt = Date.now()
  const timeoutSignal =
    options.timeoutMs == null ? undefined : AbortSignal.timeout(options.timeoutMs)
  const signal =
    options.signal && timeoutSignal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : (options.signal ?? timeoutSignal)
  const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options.body),
    signal,
  })

  if (!response.ok) {
    const prefix =
      options.failureMessagePrefix ?? `${options.providerName ?? "provider"} call failed`
    await response.body?.cancel().catch(() => undefined)
    throw new OpenAiChatCompletionHttpError(`${prefix} (${response.status})`, response.status)
  }

  const raw = await response.json()
  const payload = raw as {
    choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>
    usage?: {
      completion_tokens?: unknown
      prompt_tokens?: unknown
      total_tokens?: unknown
    }
  }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== "string" || !content) {
    throw new Error(`${options.providerName ?? "provider"} returned an empty response`)
  }
  const usageRaw = payload.usage ?? {}
  return {
    content,
    latencyMs: Date.now() - startedAt,
    raw,
    usage: {
      completionTokens: readTokenCount(usageRaw.completion_tokens),
      finishReason:
        typeof payload.choices?.[0]?.finish_reason === "string"
          ? payload.choices[0].finish_reason
          : null,
      promptTokens: readTokenCount(usageRaw.prompt_tokens),
      totalTokens: readTokenCount(usageRaw.total_tokens),
    },
  }
}
