import type { AiFailureReason } from "../pipeline/ai-health.js"
import { resolveEmbeddingCredentials, type EnvReader } from "../pipeline/llm-config.js"
import { readGatewayApiKey } from "../pipeline/llm-gateway.js"

export const AI_HEALTH_STATUSES = [
  "available",
  "unavailable",
  "not_configured",
  "disabled",
  "unknown",
] as const
export type AiHealthStatus = (typeof AI_HEALTH_STATUSES)[number]

const MEMORY_FEATURES = new Set(["tag-memory", "review-memory", "source-auto-reject"])

export interface AiFeatureAssignment {
  feature: string
  provider: string | null
  enabled: boolean
}

export interface AiCallHealthRow {
  feature: string
  provider: string
  model: string
  last_success_at: string | null
  last_failure_at: string | null
  last_failure_reason: AiFailureReason | null
}

export interface AiFeatureHealth extends AiFeatureAssignment {
  credentials_configured: boolean
}

export interface AiLastFailure {
  feature: string
  provider: string
  model: string
  reason: AiFailureReason
  at: string
}

export interface AiHealthSummary {
  status: AiHealthStatus
  gateway_key_configured: boolean
  features: AiFeatureHealth[]
  last_failure: AiLastFailure | null
  last_success_at: string | null
}

function hasAny(env: EnvReader, names: string[]): boolean {
  return names.some((name) => Boolean(env.get(name)?.trim()))
}

/** Presence only: a configured key can still be rejected, which calls report. */
export function providerCredentialsConfigured(provider: string | null, env: EnvReader): boolean {
  switch (provider) {
    case "gateway":
      return Boolean(readGatewayApiKey(env))
    case "openai":
      return hasAny(env, ["LLM_REVIEW_API_KEY", "AI_API_KEY", "OPENAI_API_KEY"])
    case "ollama":
    case "localai":
      return hasAny(env, ["LLM_REVIEW_BASE_URL", "AI_BASE_URL"])
    default:
      return false
  }
}

function latest(values: Array<string | null>): string | null {
  return values.reduce<string | null>(
    (best, value) => (value !== null && (best === null || value > best) ? value : best),
    null
  )
}

function isFailing(row: AiCallHealthRow): boolean {
  return (
    row.last_failure_at !== null &&
    (row.last_success_at === null || row.last_failure_at > row.last_success_at)
  )
}

/**
 * Timestamps must share one sortable ISO-8601 UTC format. Call rows from a
 * disabled or reassigned model feature are ignored so a stale failure from a
 * replaced provider does not keep the dashboard red.
 */
export function summarizeAiHealth(input: {
  assignments: AiFeatureAssignment[]
  calls: AiCallHealthRow[]
  env: EnvReader
}): AiHealthSummary {
  const embeddingsConfigured = resolveEmbeddingCredentials(input.env) !== null
  const features = input.assignments.map((assignment) => ({
    ...assignment,
    credentials_configured: MEMORY_FEATURES.has(assignment.feature)
      ? embeddingsConfigured
      : providerCredentialsConfigured(assignment.provider, input.env),
  }))
  const byFeature = new Map(features.map((feature) => [feature.feature, feature]))
  const counted = input.calls.filter((row) => {
    const assignment = byFeature.get(row.feature)
    return !assignment || (assignment.enabled && assignment.provider === row.provider)
  })
  const failing = counted.filter(isFailing)
  const lastFailureRow = failing.reduce<AiCallHealthRow | null>(
    (best, row) =>
      best === null || (row.last_failure_at ?? "") > (best.last_failure_at ?? "") ? row : best,
    null
  )
  const last_failure =
    lastFailureRow?.last_failure_at && lastFailureRow.last_failure_reason
      ? {
          feature: lastFailureRow.feature,
          provider: lastFailureRow.provider,
          model: lastFailureRow.model,
          reason: lastFailureRow.last_failure_reason,
          at: lastFailureRow.last_failure_at,
        }
      : null
  const last_success_at = latest(counted.map((row) => row.last_success_at))
  const enabled = features.filter((feature) => feature.enabled)

  let status: AiHealthStatus
  if (enabled.length === 0) status = "disabled"
  else if (enabled.some((feature) => !feature.credentials_configured)) status = "not_configured"
  else if (last_failure) status = "unavailable"
  else if (last_success_at) status = "available"
  else status = "unknown"

  return {
    status,
    gateway_key_configured: Boolean(readGatewayApiKey(input.env)),
    features,
    last_failure,
    last_success_at,
  }
}
