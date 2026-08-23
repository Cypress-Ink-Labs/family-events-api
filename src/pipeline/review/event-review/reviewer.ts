import { resolveLlmReviewConfig } from "./config.js"
import { normalizeReviewEventInput } from "./normalizer.js"
import { buildReviewPrompt } from "./prompt.js"
import { applyConfidenceThreshold, parseLlmDecisionJson } from "./schema.js"
import { buildLlmReviewProvider } from "./provider.js"
import type {
  AppliedLlmEventReviewDecision,
  LlmReviewConfig,
  ReviewEventDeps,
  ReviewEventInput,
} from "./types.js"
import { LLM_EVENT_REVIEW_DECISION, LLM_EVENT_REVIEW_STATUS } from "./types.js"

function failedDecision(
  config: LlmReviewConfig,
  reason: string,
  errorCode: string,
  processingMs: number,
  errorMessage: string | null = null
): AppliedLlmEventReviewDecision {
  return {
    status: LLM_EVENT_REVIEW_STATUS.FAILED,
    modelDecision: null,
    appliedDecision: LLM_EVENT_REVIEW_DECISION.NEEDS_ADMIN_REVIEW,
    confidence: null,
    reason,
    flags: [errorCode],
    suggestedCategory: null,
    normalizedTitle: null,
    provider: config.provider,
    model: config.model,
    promptVersion: config.promptVersion,
    rawResponse: null,
    errorCode,
    errorMessage,
    processingMs,
  }
}

export interface ReviewMemoryContext {
  memoryPrompt: string
  similarEventIds: string[]
  confidenceDelta: number
  confidenceReason: string
}

export async function reviewEventWithLlm(
  input: ReviewEventInput,
  deps?: Partial<ReviewEventDeps>,
  memoryContext?: ReviewMemoryContext | null
): Promise<AppliedLlmEventReviewDecision> {
  const startedAt = deps?.now?.() ?? Date.now()
  const config = deps?.config ?? resolveLlmReviewConfig()

  if (!config.enabled) {
    const elapsed = (deps?.now?.() ?? Date.now()) - startedAt
    return {
      status: LLM_EVENT_REVIEW_STATUS.NOT_REQUIRED,
      modelDecision: null,
      appliedDecision: LLM_EVENT_REVIEW_DECISION.NEEDS_ADMIN_REVIEW,
      confidence: null,
      reason: "LLM review is disabled; routing to admin review.",
      flags: ["disabled"],
      suggestedCategory: null,
      normalizedTitle: null,
      provider: config.provider,
      model: config.model,
      promptVersion: config.promptVersion,
      rawResponse: null,
      errorCode: "disabled",
      errorMessage: null,
      processingMs: elapsed,
    } satisfies AppliedLlmEventReviewDecision
  }

  if (!config.valid) {
    const elapsed = (deps?.now?.() ?? Date.now()) - startedAt
    return failedDecision(
      config,
      "LLM review configuration is invalid; routing to admin review.",
      config.invalidReason ?? "invalid_config",
      elapsed,
      config.invalidReason
    )
  }

  const normalized = normalizeReviewEventInput(input)
  if (!normalized.normalized || normalized.fallback) {
    const elapsed = (deps?.now?.() ?? Date.now()) - startedAt
    return failedDecision(
      config,
      normalized.fallback?.reason ??
        "Input is incomplete for automated review; routing to admin review.",
      normalized.fallback?.code ?? "invalid_input",
      elapsed
    )
  }

  const prompt = buildReviewPrompt(normalized.normalized, memoryContext?.memoryPrompt)
  const provider = deps?.provider ?? buildLlmReviewProvider(config)

  try {
    const providerOutput = await provider.review(
      {
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        model: config.model,
      },
      AbortSignal.timeout(config.timeoutMs)
    )

    const parsed = parseLlmDecisionJson(providerOutput.rawText)
    const applied = applyConfidenceThreshold(parsed, config.confidenceThreshold)
    const elapsed = (deps?.now?.() ?? Date.now()) - startedAt

    // Apply memory-based confidence adjustment
    let adjustedConfidence = applied.confidence
    const memoryFlags: string[] = []
    if (memoryContext && memoryContext.confidenceDelta !== 0 && adjustedConfidence !== null) {
      adjustedConfidence = Math.max(
        0,
        Math.min(1, adjustedConfidence + memoryContext.confidenceDelta)
      )
      memoryFlags.push("memory_context_used")
      if (memoryContext.confidenceDelta > 0) memoryFlags.push("memory_confidence_boosted")
      if (memoryContext.confidenceDelta < 0) memoryFlags.push("memory_confidence_penalized")
    } else if (memoryContext) {
      memoryFlags.push("memory_context_used")
    }

    return {
      status: LLM_EVENT_REVIEW_STATUS.SUCCEEDED,
      modelDecision: applied.modelDecision,
      appliedDecision: applied.appliedDecision,
      confidence: adjustedConfidence,
      reason: memoryContext?.confidenceDelta
        ? `${applied.reason} [Memory: ${memoryContext.confidenceReason}]`
        : applied.reason,
      flags: [
        ...new Set([
          ...applied.flags,
          ...(applied.lowConfidence ? ["low_confidence"] : []),
          ...memoryFlags,
        ]),
      ],
      suggestedCategory: applied.suggestedCategory,
      normalizedTitle: applied.normalizedTitle,
      provider: providerOutput.provider,
      model: providerOutput.model,
      promptVersion: config.promptVersion,
      rawResponse: config.persistRawResponse ? providerOutput.rawResponse : null,
      errorCode: null,
      errorMessage: null,
      processingMs: elapsed,
    }
  } catch (error) {
    const elapsed = (deps?.now?.() ?? Date.now()) - startedAt
    const message = error instanceof Error ? error.message : String(error)
    const errorCode = message.includes("timeout")
      ? "provider_timeout"
      : message.startsWith("provider_http_")
        ? "provider_http_error"
        : message === "invalid_json"
          ? "malformed_json"
          : message.startsWith("invalid_") || message.startsWith("unexpected_key")
            ? "schema_validation_error"
            : "provider_error"

    return failedDecision(
      config,
      "Automated review failed; routing to admin review.",
      errorCode,
      elapsed,
      message
    )
  }
}
