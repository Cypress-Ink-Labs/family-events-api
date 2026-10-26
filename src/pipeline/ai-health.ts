// Process-wide record of AI provider call outcomes, read by the operator
// dashboard. Pipeline helpers report each provider call here; the Nest
// AiHealthRecorder persists them. Outcomes carry no prompts, responses,
// upstream bodies or credentials, only the feature, provider, model and a
// coarse failure reason.

import { errorMessage, logEdgeEvent } from "./logger.js"

export const AI_CALL_FEATURES = [
  "tagging",
  "event-review",
  "parent-tips",
  "embeddings",
  "source-extraction",
] as const
export type AiCallFeature = (typeof AI_CALL_FEATURES)[number]

export const AI_FAILURE_REASONS = [
  "unauthorized",
  "rate_limited",
  "timeout",
  "provider_error",
] as const
export type AiFailureReason = (typeof AI_FAILURE_REASONS)[number]

export interface AiCallTelemetry {
  feature: AiCallFeature
  provider: string
  model: string
}

export interface AiCallOutcome extends AiCallTelemetry {
  failure: AiFailureReason | null
}

export type AiOutcomeRecorder = (outcome: AiCallOutcome) => Promise<void>

let recorder: AiOutcomeRecorder | null = null

export function setAiOutcomeRecorder(next: AiOutcomeRecorder | null): void {
  recorder = next
}

/** Fire-and-forget: a failed health write never changes the pipeline result. */
export function recordAiOutcome(outcome: AiCallOutcome): void {
  const current = recorder
  if (!current) return
  void current(outcome).catch((error: unknown) => {
    logEdgeEvent("warn", "ai health outcome was not recorded", {
      feature: outcome.feature,
      error: errorMessage(error),
    })
  })
}

export function failureReasonForStatus(status: number): AiFailureReason {
  if (status === 401 || status === 403) return "unauthorized"
  if (status === 429) return "rate_limited"
  if (status === 408 || status === 504) return "timeout"
  return "provider_error"
}

function statusOf(error: object): number | null {
  const { statusCode, status } = error as { statusCode?: unknown; status?: unknown }
  if (typeof statusCode === "number") return statusCode
  return typeof status === "number" ? status : null
}

/**
 * Transport failures make AI unavailable; a provider that answered with
 * unusable content does not, so those return null and count as reachable.
 */
export function classifyAiFailure(error: unknown): AiFailureReason | null {
  if (typeof error !== "object" || error === null) return null
  const name = (error as { name?: unknown }).name
  if (name === "AbortError" || name === "TimeoutError") return "timeout"
  const status = statusOf(error)
  if (status !== null) return failureReasonForStatus(status)
  if (name === "GatewayAuthenticationError") return "unauthorized"
  if (name === "GatewayRateLimitError") return "rate_limited"
  if (name === "GatewayTimeoutError") return "timeout"
  if (typeof name === "string" && (name.startsWith("Gateway") || name === "AI_APICallError"))
    return "provider_error"
  if (error instanceof TypeError) return "provider_error"
  return null
}

export async function withAiTelemetry<T>(
  telemetry: AiCallTelemetry | undefined,
  call: () => Promise<T>
): Promise<T> {
  if (!telemetry) return call()
  try {
    const result = await call()
    recordAiOutcome({ ...telemetry, failure: null })
    return result
  } catch (error) {
    recordAiOutcome({ ...telemetry, failure: classifyAiFailure(error) })
    throw error
  }
}
