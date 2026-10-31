// Vercel AI Gateway transport over the AI SDK. One AI_GATEWAY_API_KEY reaches
// every approved gateway model, e.g. "openai/gpt-6-luna" for chat and
// "openai/text-embedding-3-small" for embeddings.

import {
  createGateway,
  embed,
  generateText,
  NoObjectGeneratedError,
  Output,
  type EmbeddingModel,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai"

import { withAiTelemetry, type AiCallFeature } from "./ai-health.js"
import type { EnvReader } from "./llm-config.js"
import { OpenAiChatCompletionHttpError, type ChatCompletionResult } from "./llm-openai.js"

export const GATEWAY_PROVIDER = "gateway"
export const GATEWAY_SPEND_TAG = "family-events-api"
export const GATEWAY_API_KEY_ENV = "AI_GATEWAY_API_KEY"
export const DEFAULT_GATEWAY_MODEL = "openai/gpt-6-luna"
export const GATEWAY_EMBEDDING_MODEL = "openai/text-embedding-3-small"

/** Keep in step with the gateway rows in public.approved_ai_models. */
export const APPROVED_GATEWAY_MODELS: ReadonlySet<string> = new Set([
  "openai/gpt-6-luna",
  "openai/gpt-6-luna-fast",
  "spacexai/grok-4.20-non-reasoning",
  "spacexai/grok-4.3",
  "spacexai/grok-4.7",
])

const TAGGING_REASONING_OFF_MODELS: ReadonlySet<string> = new Set([
  "openai/gpt-6-luna",
  "openai/gpt-6-luna-fast",
])

export function gatewayUsageTags(feature: AiCallFeature): { gateway: { tags: string[] } } {
  return { gateway: { tags: [GATEWAY_SPEND_TAG, `feature:${feature}`] } }
}

export function gatewayReasoning(feature: AiCallFeature, model: string): "none" | "low" {
  return feature === "tagging" && TAGGING_REASONING_OFF_MODELS.has(model) ? "none" : "low"
}

export function resolveGatewayModel(model: string | null | undefined): string {
  return model && APPROVED_GATEWAY_MODELS.has(model) ? model : DEFAULT_GATEWAY_MODEL
}

export function readGatewayApiKey(env: EnvReader): string {
  return env.get(GATEWAY_API_KEY_ENV)?.trim() ?? ""
}

export interface GatewayModels {
  languageModel(modelId: string): LanguageModel
  embeddingModel(modelId: string): EmbeddingModel
}

export function createGatewayModels(apiKey: string): GatewayModels {
  return createGateway({ apiKey })
}

/**
 * A gateway HTTP failure, reported with the status code only. Upstream bodies
 * and SDK messages stay out of traces and logs.
 */
export class GatewayHttpError extends OpenAiChatCompletionHttpError {
  constructor(message: string, status: number) {
    super(message, status)
    this.name = "GatewayHttpError"
  }
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null
  const status = (error as { statusCode?: unknown }).statusCode
  return typeof status === "number" ? status : null
}

function sanitize(error: unknown, prefix: string): unknown {
  const status = httpStatus(error)
  return status === null ? error : new GatewayHttpError(`${prefix} (${status})`, status)
}

function combineSignals(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  const timeout = timeoutMs == null ? undefined : AbortSignal.timeout(timeoutMs)
  return signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout)
}

interface GatewayCompletion {
  text: string
  usage: LanguageModelUsage | undefined
  finishReason: FinishReason | undefined
  raw: unknown
}

export interface GatewayTextOptions {
  apiKey: string
  model: string
  system: string
  prompt: string
  temperature: number
  feature: AiCallFeature
  failureMessagePrefix: string
  signal?: AbortSignal
  timeoutMs?: number
  models?: GatewayModels
}

/**
 * Generate one JSON-mode completion. Retries stay with the calling queue, so
 * the SDK makes exactly one request per call, as the legacy helper did.
 */
export async function generateGatewayText(
  options: GatewayTextOptions
): Promise<ChatCompletionResult> {
  const models = options.models ?? createGatewayModels(options.apiKey)
  const startedAt = Date.now()
  return withAiTelemetry(
    { feature: options.feature, provider: GATEWAY_PROVIDER, model: options.model },
    async () => {
      let completion: GatewayCompletion
      try {
        const result = await generateText({
          model: models.languageModel(options.model),
          system: options.system,
          prompt: options.prompt,
          temperature: options.temperature,
          reasoning: gatewayReasoning(options.feature, options.model),
          providerOptions: gatewayUsageTags(options.feature),
          output: Output.json(),
          maxRetries: 0,
          abortSignal: combineSignals(options.signal, options.timeoutMs),
        })
        completion = {
          text: result.text,
          usage: result.usage,
          finishReason: result.finishReason,
          raw: result.response.body ?? null,
        }
      } catch (error) {
        // Callers own JSON parsing and their keyword/heuristic fallbacks, as
        // with the legacy transport, so non-JSON text is returned, not thrown.
        if (!NoObjectGeneratedError.isInstance(error))
          throw sanitize(error, options.failureMessagePrefix)
        completion = {
          text: error.text ?? "",
          usage: error.usage,
          finishReason: error.finishReason,
          raw: null,
        }
      }
      if (!completion.text) throw new Error(`${GATEWAY_PROVIDER} returned an empty response`)
      return {
        content: completion.text,
        latencyMs: Date.now() - startedAt,
        raw: completion.raw,
        usage: {
          promptTokens: completion.usage?.inputTokens ?? null,
          completionTokens: completion.usage?.outputTokens ?? null,
          totalTokens: completion.usage?.totalTokens ?? null,
          finishReason: completion.finishReason ?? null,
        },
      }
    }
  )
}

export interface GatewayEmbeddingOptions {
  apiKey: string
  value: string
  dimensions: number
  feature?: AiCallFeature
  timeoutMs?: number
  models?: GatewayModels
}

export async function generateGatewayEmbedding(
  options: GatewayEmbeddingOptions
): Promise<number[]> {
  const models = options.models ?? createGatewayModels(options.apiKey)
  return withAiTelemetry(
    {
      feature: options.feature ?? "embeddings",
      provider: GATEWAY_PROVIDER,
      model: GATEWAY_EMBEDDING_MODEL,
    },
    async () => {
      let embedding: number[]
      try {
        ;({ embedding } = await embed({
          model: models.embeddingModel(GATEWAY_EMBEDDING_MODEL),
          value: options.value,
          dimensions: options.dimensions,
          providerOptions: gatewayUsageTags(options.feature ?? "embeddings"),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        }))
      } catch (error) {
        throw sanitize(error, "AI Gateway embeddings failed")
      }
      if (embedding.length !== options.dimensions) {
        throw new Error(`AI Gateway returned unexpected embedding dimensions: ${embedding.length}`)
      }
      return embedding
    }
  )
}
