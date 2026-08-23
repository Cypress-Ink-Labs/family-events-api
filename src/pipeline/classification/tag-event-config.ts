// LLM provider/model config resolution for the tag-event classification pipeline.
// Ported verbatim from family-events-backend supabase/functions/tag-event/config.ts (U29).
// Deviations:
// - none beyond the env seam already built into resolveSharedLlmConfig (llm-config.ts),
//   which defaults to reading process.env instead of Deno.env.

import { resolveSharedLlmConfig, type SharedLlmProvider } from "../llm-config.js"

export const TAG_EVENT_PROMPT_VERSION = "v2"
export const AI_TIMEOUT_MS = 30_000
export const MAX_DESCRIPTION_CHARS = 2000
export const MAX_TITLE_CHARS = 500

export type LlmTagProvider = SharedLlmProvider

export interface TagEventLlmConfig {
  apiKey: string
  baseUrl: string
  configured: boolean
  model: string
  provider: LlmTagProvider
}

const ALLOWED_OPENAI_MODELS = new Set([
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4-turbo",
  "gpt-4.1-nano",
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-5-mini",
  "gpt-5",
])
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_OLLAMA_MODEL = "qwen3:1.7b"

export function resolveTagEventAiConfig(
  dbConfig?: { enabled: boolean; modelId: string; provider: string } | null
): TagEventLlmConfig {
  const config = resolveSharedLlmConfig({
    allowedOpenAiModels: ALLOWED_OPENAI_MODELS,
    dbOverride:
      dbConfig == null
        ? null
        : {
            enabled: dbConfig.enabled,
            modelId: dbConfig.modelId,
            provider: dbConfig.provider,
          },
    defaultOpenAiBaseUrl: DEFAULT_AI_BASE_URL,
    defaultOpenAiModel: DEFAULT_OPENAI_MODEL,
    selfHostedDefaultModel: DEFAULT_OLLAMA_MODEL,
  })
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    configured: config.configured,
    model: config.model,
    provider: config.provider,
  }
}

export function resolveTagEventOpenAiModel(configuredModel: string): string {
  return ALLOWED_OPENAI_MODELS.has(configuredModel) ? configuredModel : DEFAULT_OPENAI_MODEL
}
