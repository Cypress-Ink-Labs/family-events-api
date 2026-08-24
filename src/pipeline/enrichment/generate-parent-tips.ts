// Parent-tips generation: resolves the LLM config for the `parent-tips`
// feature and calls the LLM to produce 1-3 tips for a candidate event.
// Ported from family-events-backend supabase/functions/generate-parent-tips/handler.ts
// (config load :88-111, `resolveAiConfig` :113-145, `generateWithLlm` :218-283) (U29).
//
// Deviations:
// - The Deno HTTP handler shell (CORS, service-role auth, request-body
//   parsing, Supabase event/tag loading, Sentry capture, success/error
//   response bodies) is dropped entirely — its only caller was another edge
//   function; Task 7 calls `generateParentTipsForEvent` in-process instead.
//   DB access is expressed as the `ParentTipsDb` seam (worker purity: no pg
//   or Nest imports here).
// - Legacy's `generateWithLlm` only produced tips + telemetry; the handler
//   then issued the `update_event_parent_tips` RPC itself (handler.ts:351-358)
//   only when `generateWithLlm` did not throw. `generateParentTipsForEvent`
//   folds both steps together and reports the outcome as a
//   `GenerateParentTipsResult` discriminated union: on "generated" the DB
//   write has already happened; on "failed" (thrown HTTP/parse error, or
//   zero valid tips survived filtering) no DB write has happened, mirroring
//   the legacy try/catch boundary exactly. The caller decides whether to call
//   `markEnrichmentAttempt` on "failed" — matching the legacy caller split,
//   where only the separate "AI provider not configured" branch
//   (handler.ts:340-346) called `mark_event_enrichment_attempt` itself.
// - Legacy's wire tip shape `{ category, text }` (what `PARENT_TIPS_JSON_SCHEMA`
//   asks the model for) is normalized to `{ category, tip }` per the brief's
//   `ParentTip` interface — only the field name changes on the way out; the
//   JSON schema sent to the model is untouched.
//
// CRITICAL (deviation #6, binding): `ALLOWED_OPENAI_MODELS` below is a
// *verbatim* copy of legacy handler.ts:25-34, including the fact that it is
// stale — it does not include the gpt-5.4* model ids that were later seeded
// into `approved_ai_models`. Because of this, a DB-configured `gpt-5.4-nano`
// silently falls back to `DEFAULT_OPENAI_MODEL` ("gpt-4.1-nano") via
// `resolveSharedLlmConfig`'s allowlist check. This reproduces production
// behavior exactly and is intentional for U33 cutover parity — do NOT
// "fix"/extend this allowlist as part of this port.

import { resolveSharedLlmConfig, type EnvReader, type SharedLlmProvider } from "../llm-config.js"
import { parseJsonContent, postOpenAiChatCompletion } from "../llm-openai.js"
import {
  buildParentTipsSystemPrompt,
  buildParentTipsUserPrompt,
  LLM_PARENT_TIPS_PROMPT_VERSION,
  PARENT_TIP_CATEGORIES,
  PARENT_TIPS_JSON_SCHEMA,
  type ParentTipCategory,
} from "./parent-tips-prompt.js"

const AI_TIMEOUT_MS = 30_000

// Verbatim from legacy handler.ts:25-34. See the file-level deviation #6 note
// above — this allowlist is deliberately stale; do not add models to it here.
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
const DEFAULT_OPENAI_MODEL = "gpt-4.1-nano"
const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_OLLAMA_MODEL = "qwen3:1.7b"

export interface ParentTipsCandidate {
  eventId: string
  title: string
  description: string | null
  ageMin: number | null
  ageMax: number | null
  isOutdoor: boolean | null
  venueName: string | null
  startDatetime: string | null
  tags: string[]
}

export interface ParentTip {
  category: ParentTipCategory
  tip: string
}

export interface ParentTipsDb {
  /** SELECT cfg.model_id, models.provider, cfg.enabled FROM public.ai_feature_config cfg LEFT JOIN public.approved_ai_models models ON models.id = cfg.model_id WHERE cfg.feature = 'parent-tips' — mirrors ClassificationRepository.loadTagFeatureConfig (classification.repository.ts:108). */
  loadParentTipsFeatureConfig(): Promise<{
    modelId: string | null
    provider: string | null
    enabled: boolean
  } | null>
  /** private.list_events_needing_parent_tips(p_limit) */
  listEventsNeedingParentTips(limit: number): Promise<ParentTipsCandidate[]>
  /** private.update_event_parent_tips(...) */
  updateEventParentTips(
    eventId: string,
    tips: ParentTip[],
    provider: string,
    model: string,
    promptVersion: string
  ): Promise<void>
  /** private.mark_event_enrichment_attempt(p_event_id) */
  markEnrichmentAttempt(eventId: string): Promise<void>
}

export interface ParentTipsLlmConfig {
  provider: SharedLlmProvider
  model: string
  baseUrl: string
  apiKey: string | null
  enabled: boolean
  configured: boolean
}

/**
 * Resolve the parent-tips LLM config on top of `resolveSharedLlmConfig`.
 * Ported from legacy `resolveAiConfig` (handler.ts:113-145): a missing DB row
 * means the feature has never been configured — fully unconfigured, provider
 * defaults to "openai", matching legacy's early-return shape exactly.
 * Otherwise the shared resolver applies the (verbatim, deliberately stale —
 * see deviation #6 above) OpenAI model allowlist, and `enabled` gates
 * `configured` via `resolveSharedLlmConfig`'s own `enabled && ...` check.
 */
export function resolveParentTipsAiConfig(
  dbConfig: { modelId: string | null; provider: string | null; enabled: boolean } | null,
  env?: EnvReader
): ParentTipsLlmConfig {
  if (!dbConfig) {
    return {
      provider: "openai",
      model: DEFAULT_OPENAI_MODEL,
      baseUrl: "",
      apiKey: null,
      enabled: false,
      configured: false,
    }
  }

  const config = resolveSharedLlmConfig(
    {
      allowedOpenAiModels: ALLOWED_OPENAI_MODELS,
      dbOverride: {
        enabled: dbConfig.enabled,
        modelId: dbConfig.modelId,
        provider: dbConfig.provider,
      },
      defaultOpenAiBaseUrl: DEFAULT_AI_BASE_URL,
      defaultOpenAiModel: DEFAULT_OPENAI_MODEL,
      selfHostedDefaultModel: DEFAULT_OLLAMA_MODEL,
    },
    env
  )

  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || null,
    enabled: dbConfig.enabled,
    configured: config.configured,
  }
}

export type GenerateParentTipsResult =
  | { status: "generated"; tips: ParentTip[]; provider: string; model: string }
  | { status: "failed"; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Generate parent tips for one candidate event and persist them. Ported from
 * legacy `generateWithLlm` (handler.ts:218-283) plus the
 * `update_event_parent_tips` call the handler made right after it returned
 * (handler.ts:351-358). On "generated" the DB write has already happened; on
 * "failed" no DB write has happened — see the file-level deviation note above
 * for why the caller (not this function) decides about `markEnrichmentAttempt`.
 */
export async function generateParentTipsForEvent(
  db: ParentTipsDb,
  candidate: ParentTipsCandidate,
  config: ParentTipsLlmConfig,
  deps?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<GenerateParentTipsResult> {
  const systemPrompt = buildParentTipsSystemPrompt()
  const userPrompt = buildParentTipsUserPrompt(candidate)

  try {
    const completion = await postOpenAiChatCompletion({
      apiKey: config.apiKey ?? "",
      baseUrl: config.baseUrl,
      body: {
        model: config.model,
        temperature: 0.2,
        response_format:
          config.provider === "openai"
            ? {
                type: "json_schema" as const,
                json_schema: {
                  name: "parent_tips",
                  strict: true,
                  schema: PARENT_TIPS_JSON_SCHEMA,
                },
              }
            : { type: "json_object" as const },
        ...(config.provider === "ollama" ? { reasoning_effort: "none" } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      },
      fetchImpl: deps?.fetchImpl,
      failureMessagePrefix: `${config.provider} parent-tips call failed`,
      providerName: config.provider,
      timeoutMs: deps?.timeoutMs ?? AI_TIMEOUT_MS,
    })

    const parsed = parseJsonContent(completion.content)
    const rawTips = Array.isArray(parsed.tips) ? parsed.tips : []

    const allowed = new Set<string>(PARENT_TIP_CATEGORIES)
    const seenCategories = new Set<string>()
    const tips: ParentTip[] = []
    for (const entry of rawTips) {
      if (!isRecord(entry)) continue
      const category = typeof entry.category === "string" ? entry.category : ""
      const text = typeof entry.text === "string" ? entry.text.trim() : ""
      if (!allowed.has(category)) continue
      if (text.length === 0) continue
      if (seenCategories.has(category)) continue
      tips.push({ category: category as ParentTipCategory, tip: text })
      seenCategories.add(category)
      if (tips.length === 3) break
    }

    if (tips.length === 0) {
      return { status: "failed", error: "model returned no valid parent tips" }
    }

    await db.updateEventParentTips(
      candidate.eventId,
      tips,
      config.provider,
      config.model,
      LLM_PARENT_TIPS_PROMPT_VERSION
    )

    return { status: "generated", tips, provider: config.provider, model: config.model }
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) }
  }
}
