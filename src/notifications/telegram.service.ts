import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import { TelegramRepository } from "./telegram.repository.js"

const TELEGRAM_API_BASE = "https://api.telegram.org"
const TELEGRAM_TIMEOUT_MS = 10_000
const TELEGRAM_TOKEN_TTL_MS = 5 * 60 * 1000
const TELEGRAM_TOKEN = /^\d+:[A-Za-z0-9_-]+$/

export interface SendTelegramInput {
  chatId: string | null
  text: string
}

export type SendTelegramResult =
  | { sent: true }
  | { sent: false; reason: "failed" | "missing_configuration" }

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name)
  private cachedToken: { value: string; expiresAt: number } | null = null

  constructor(
    private readonly repository: TelegramRepository,
    private readonly config: ConfigService<Env, true>
  ) {}

  async send(input: SendTelegramInput): Promise<SendTelegramResult> {
    const token = await this.botToken()
    const chatId = input.chatId?.trim()
    if (!token || !chatId) {
      this.logger.warn("Telegram digest skipped: missing token or chat ID")
      return { sent: false, reason: "missing_configuration" }
    }

    try {
      const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: input.text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      })
      const body: unknown = await response.json()
      if (
        response.ok &&
        body !== null &&
        typeof body === "object" &&
        "ok" in body &&
        body.ok === true
      ) {
        return { sent: true }
      }
      this.logger.warn("Telegram digest delivery rejected")
    } catch {
      // Transport errors can contain the token-bearing URL. Never log them.
      this.logger.warn("Telegram digest delivery failed")
    }
    return { sent: false, reason: "failed" }
  }

  private async botToken(): Promise<string | null> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value
    }
    const token = await this.resolveBotToken()
    // Do not cache missing or invalid configuration: a transient Vault outage
    // must recover without requiring a process restart.
    this.cachedToken = token
      ? { value: token, expiresAt: Date.now() + TELEGRAM_TOKEN_TTL_MS }
      : null
    return token
  }

  private async resolveBotToken(): Promise<string | null> {
    const vaultToken = await this.repository.loadBotToken()
    const token =
      vaultToken || (this.config.get("TELEGRAM_BOT_TOKEN", { infer: true })?.trim() ?? "")
    if (!token) return null
    if (!TELEGRAM_TOKEN.test(token)) {
      this.logger.warn("Telegram digest skipped: invalid token configuration")
      return null
    }
    return token
  }
}
