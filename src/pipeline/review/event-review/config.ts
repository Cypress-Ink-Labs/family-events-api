import type { LlmReviewConfig } from "./types.js"
import { LLM_EVENT_REVIEW_PROMPT_VERSION } from "./prompt.js"

export interface EnvReader {
  get(name: string): string | undefined
}

const processEnvReader: EnvReader = {
  get: (name) => process.env[name],
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === "true") return true
  if (normalized === "false") return false
  return fallback
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number
): { value: number; valid: boolean } {
  if (value == null || value.trim() === "") {
    return { value: fallback, valid: true }
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return { value: fallback, valid: false }
  const rounded = Math.floor(parsed)
  if (rounded <= 0) return { value: fallback, valid: false }
  return { value: rounded, valid: true }
}

function parseThreshold(
  value: string | undefined,
  fallback: number
): { value: number; valid: boolean } {
  if (value == null || value.trim() === "") {
    return { value: fallback, valid: true }
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return { value: fallback, valid: false }
  return { value: parsed, valid: true }
}

function normalizeBaseUrl(value: string | undefined): string {
  if (!value) return ""
  return value.trim().replace(/\/+$/, "")
}

export function resolveLlmReviewConfig(
  env: EnvReader = processEnvReader,
  dbOverrides?: { model: string; enabled: boolean; provider?: string | null } | null
): LlmReviewConfig {
  const enabled =
    dbOverrides != null ? dbOverrides.enabled : parseBoolean(env.get("LLM_REVIEW_ENABLED"), false)
  const provider =
    dbOverrides?.provider ??
    env.get("LLM_REVIEW_PROVIDER") ??
    env.get("AI_PROVIDER") ??
    "openai-compatible"
  const baseUrl = normalizeBaseUrl(env.get("LLM_REVIEW_BASE_URL") ?? env.get("AI_BASE_URL"))
  const model = (
    dbOverrides?.model ??
    env.get("LLM_REVIEW_MODEL") ??
    env.get("AI_MODEL") ??
    ""
  ).trim()
  const apiKey = (env.get("LLM_REVIEW_API_KEY") ?? env.get("AI_API_KEY") ?? "").trim()
  const promptVersion =
    (env.get("LLM_REVIEW_PROMPT_VERSION") ?? LLM_EVENT_REVIEW_PROMPT_VERSION).trim() ||
    LLM_EVENT_REVIEW_PROMPT_VERSION
  const parsedThreshold = parseThreshold(env.get("LLM_REVIEW_CONFIDENCE_THRESHOLD"), 0.75)
  const parsedTimeoutMs = parsePositiveInt(env.get("LLM_REVIEW_TIMEOUT_MS"), 30_000)
  const parsedMaxAttempts = parsePositiveInt(env.get("LLM_REVIEW_MAX_ATTEMPTS"), 3)
  const parsedRetryBaseMs = parsePositiveInt(env.get("LLM_REVIEW_RETRY_BASE_MS"), 60_000)
  const confidenceThreshold = parsedThreshold.value
  const timeoutMs = parsedTimeoutMs.value
  const maxAttempts = parsedMaxAttempts.value
  const retryBaseMs = parsedRetryBaseMs.value
  const persistRawResponse = parseBoolean(env.get("LLM_REVIEW_PERSIST_RAW_RESPONSE"), false)

  let valid = true
  let invalidReason: string | null = null

  if (enabled) {
    if (!model) {
      valid = false
      invalidReason = "missing_model"
    } else if (!apiKey) {
      valid = false
      invalidReason = "missing_api_key"
    } else if (!baseUrl) {
      valid = false
      invalidReason = "missing_base_url"
    } else if (!parsedThreshold.valid || !(confidenceThreshold >= 0 && confidenceThreshold <= 1)) {
      valid = false
      invalidReason = "invalid_confidence_threshold"
    } else if (!parsedTimeoutMs.valid || timeoutMs <= 0) {
      valid = false
      invalidReason = "invalid_timeout"
    } else if (!parsedMaxAttempts.valid || maxAttempts <= 0) {
      valid = false
      invalidReason = "invalid_max_attempts"
    } else if (!parsedRetryBaseMs.valid || retryBaseMs <= 0) {
      valid = false
      invalidReason = "invalid_retry_base"
    }
  }

  return {
    enabled,
    provider,
    baseUrl,
    model,
    apiKey,
    promptVersion,
    confidenceThreshold,
    timeoutMs,
    maxAttempts,
    retryBaseMs,
    persistRawResponse,
    valid,
    invalidReason,
  }
}
