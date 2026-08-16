import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"

export type FailurePingKind = "run_failed" | "dead_letter" | "function_failed"

export interface FailurePingInput {
  functionName: string
  kind: FailurePingKind
  subject?: string
  error: string
}

export type FailurePingOutcome = "sent" | "skipped" | "failed"

const KIND_LABELS: Record<FailurePingKind, string> = {
  run_failed: "run failed",
  dead_letter: "dead-lettered",
  function_failed: "function crashed",
}

const TELEGRAM_API_BASE = "https://api.telegram.org"
const TELEGRAM_TIMEOUT_MS = 10_000

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function buildFailurePingText(input: FailurePingInput): string {
  const lines = [
    `⚠️ <b>${escapeHtml(input.functionName)}</b>: ${KIND_LABELS[input.kind]}`,
    input.subject ? `source: ${escapeHtml(input.subject)}` : null,
    `error: ${escapeHtml(input.error.slice(0, 500))}`,
  ]
  return lines.filter((line) => line !== null).join("\n")
}

/**
 * Operator Telegram ping on pipeline failures (U3). Never throws: a ping
 * failure must not break the caller it monitors.
 */
@Injectable()
export class FailurePingService {
  private readonly logger = new Logger(FailurePingService.name)

  constructor(private readonly config: ConfigService<Env, true>) {}

  async send(input: FailurePingInput): Promise<FailurePingOutcome> {
    const botToken = this.config.get("TELEGRAM_BOT_TOKEN", { infer: true }) ?? ""
    const chatId = this.config.get("TELEGRAM_FAILURE_CHAT_ID", { infer: true }) ?? ""
    if (!botToken || !chatId) {
      this.logger.warn(
        `failure ping skipped: telegram config missing function=${input.functionName} kind=${input.kind}`
      )
      return "skipped"
    }

    try {
      const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: buildFailurePingText(input),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      })

      let body: { ok?: boolean; description?: string } | undefined
      try {
        body = (await response.json()) as { ok?: boolean; description?: string }
      } catch {
        body = undefined
      }

      if (response.ok && body?.ok === true) {
        return "sent"
      }

      const error =
        typeof body?.description === "string" ? body.description : `HTTP ${response.status}`
      this.logger.warn(
        `failure ping send failed function=${input.functionName} kind=${input.kind} error=${error}`
      )
      return "failed"
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const error = raw.replaceAll(botToken, "[REDACTED]")
      this.logger.warn(
        `failure ping threw function=${input.functionName} kind=${input.kind} error=${error}`
      )
      return "failed"
    }
  }
}
