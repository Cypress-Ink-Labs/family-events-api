// Shared LLM provider/model/key resolution. Ported verbatim from
// family-events-backend supabase/functions/_shared/llm-config.ts (U28).
// Deviation: the env seam is a minimal EnvReader defaulting to process.env
// instead of Deno.env.

export type SharedLlmProvider = "openai" | "ollama" | "localai"

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

const SUPPORTED_PROVIDERS = new Set(["openai", "ollama", "localai"])

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

export function resolveSharedLlmConfig(
  descriptor: SharedLlmConfigDescriptor,
  env: EnvReader = processEnvReader
): SharedLlmConfig {
  const db = descriptor.dbOverride
  const enabled = db?.enabled ?? descriptor.enabledDefault ?? true
  const provider = resolveLlmProvider(
    db?.provider ?? envFirst(descriptor.providerEnvNames ?? ["AI_PROVIDER"], env),
    descriptor.defaultProvider ?? "openai"
  )

  const baseUrl = normalizeLlmBaseUrl(
    envFirst(descriptor.baseUrlEnvNames ?? ["AI_BASE_URL"], env) ??
      (provider === "openai"
        ? (descriptor.defaultOpenAiBaseUrl ?? "https://api.openai.com/v1")
        : "")
  )

  const rawModel =
    db?.modelId ??
    db?.model ??
    envFirst(descriptor.modelEnvNames ?? ["AI_MODEL", "OPENAI_MODEL"], env)
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
