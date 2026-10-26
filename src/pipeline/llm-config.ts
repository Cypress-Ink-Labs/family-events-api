// Shared LLM provider/model/key resolution. Ported verbatim from
// family-events-backend supabase/functions/_shared/llm-config.ts (U28).
// Deviations:
// - The env seam is a minimal EnvReader defaulting to process.env instead of
//   Deno.env.
// - "gateway" (Vercel AI Gateway, AI_GATEWAY_API_KEY) is the default provider
//   whenever its key is set. Gateway models pass the approved gateway
//   allowlist or fall back to the Grok default. The legacy providers keep
//   their original rules and are still selected by an approved model's
//   provider, AI_PROVIDER, or the absence of a gateway key.

import { readGatewayApiKey, resolveGatewayModel } from "./llm-gateway.js"

export type SharedLlmProvider = "gateway" | "openai" | "ollama" | "localai"

export interface EnvReader {
  get(name: string): string | undefined
}

const processEnvReader: EnvReader = {
  get: (name) => process.env[name],
}

export interface SharedLlmDbOverride {
  enabled?: boolean
  model?: string | null
  modelId?: string | null
  provider?: string | null
}

export interface SharedLlmConfigDescriptor {
  allowedOpenAiModels: Set<string>
  apiKeyEnvNames?: string[]
  baseUrlEnvNames?: string[]
  dbOverride?: SharedLlmDbOverride | null
  defaultOpenAiBaseUrl?: string
  defaultOpenAiModel: string
  defaultProvider?: SharedLlmProvider
  enabledDefault?: boolean
  modelEnvNames?: string[]
  providerEnvNames?: string[]
  selfHostedDefaultModel?: string
}

export interface SharedLlmConfig {
  apiKey: string
  baseUrl: string
  configured: boolean
  enabled: boolean
  model: string
  provider: SharedLlmProvider
}

const SUPPORTED_PROVIDERS = new Set(["gateway", "openai", "ollama", "localai"])

function envFirst(names: string[], env: EnvReader): string | undefined {
  for (const name of names) {
    const value = env.get(name)
    if (value != null && value.trim() !== "") return value.trim()
  }
  return undefined
}

export function normalizeLlmBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

export function resolveLlmProvider(
  value: string | undefined | null,
  fallback: SharedLlmProvider = "openai"
): SharedLlmProvider {
  return value && SUPPORTED_PROVIDERS.has(value) ? (value as SharedLlmProvider) : fallback
}

export function defaultLlmProvider(env: EnvReader = processEnvReader): SharedLlmProvider {
  return readGatewayApiKey(env) ? "gateway" : "openai"
}

export function resolveSharedLlmConfig(
  descriptor: SharedLlmConfigDescriptor,
  env: EnvReader = processEnvReader
): SharedLlmConfig {
  const db = descriptor.dbOverride
  const enabled = db?.enabled ?? descriptor.enabledDefault ?? true
  const provider = resolveLlmProvider(
    db?.provider ?? envFirst(descriptor.providerEnvNames ?? ["AI_PROVIDER"], env),
    descriptor.defaultProvider ?? defaultLlmProvider(env)
  )

  const rawModel =
    db?.modelId ??
    db?.model ??
    envFirst(descriptor.modelEnvNames ?? ["AI_MODEL", "OPENAI_MODEL"], env)

  if (provider === "gateway") {
    const apiKey = readGatewayApiKey(env)
    return {
      apiKey,
      baseUrl: "",
      configured: enabled && Boolean(apiKey),
      enabled,
      model: resolveGatewayModel(rawModel),
      provider,
    }
  }

  const baseUrl = normalizeLlmBaseUrl(
    envFirst(descriptor.baseUrlEnvNames ?? ["AI_BASE_URL"], env) ??
      (provider === "openai"
        ? (descriptor.defaultOpenAiBaseUrl ?? "https://api.openai.com/v1")
        : "")
  )

  const model =
    provider === "openai"
      ? descriptor.allowedOpenAiModels.has(rawModel ?? "")
        ? (rawModel ?? descriptor.defaultOpenAiModel)
        : descriptor.defaultOpenAiModel
      : (rawModel ?? descriptor.selfHostedDefaultModel ?? "qwen3:1.7b")

  const openAiApiKey = envFirst(descriptor.apiKeyEnvNames ?? ["AI_API_KEY", "OPENAI_API_KEY"], env)
  const apiKey =
    provider === "openai"
      ? (openAiApiKey ?? "")
      : provider === "localai"
        ? (env.get("LOCALAI_API_KEY")?.trim() ?? "")
        : "ollama"

  return {
    apiKey,
    baseUrl,
    configured: enabled && Boolean(baseUrl && (apiKey || provider === "ollama")),
    enabled,
    model,
    provider,
  }
}

export interface EmbeddingCredentials {
  provider: "gateway" | "openai"
  apiKey: string
}

/**
 * Embeddings (tag memory, review memory, auto-embed) use the gateway key when
 * it is set and otherwise the legacy OPENAI_API_KEY. Both reach the same
 * text-embedding-3-small model, so stored vectors stay comparable.
 */
export function resolveEmbeddingCredentials(
  env: EnvReader = processEnvReader
): EmbeddingCredentials | null {
  const gatewayKey = readGatewayApiKey(env)
  if (gatewayKey) return { provider: "gateway", apiKey: gatewayKey }
  const openAiKey = env.get("OPENAI_API_KEY")?.trim() ?? ""
  return openAiKey ? { provider: "openai", apiKey: openAiKey } : null
}
