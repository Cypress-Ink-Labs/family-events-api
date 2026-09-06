import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import { PlanRepository } from "../data/plan.repository.js"
import { weekendWindowUtc } from "../pipeline/zoned-time.js"
import { buildExplanation, renderDigestEmail, type DigestEvent } from "./digest-html.js"
import { renderDigestTelegram } from "./digest-telegram.js"
import { DigestRepository, type DigestUser } from "./digest.repository.js"
import { MailService } from "./mail.service.js"
import { TelegramService } from "./telegram.service.js"

const DIGEST_TZ = "America/Chicago"
const PAGE_SIZE = 1000
const DEFAULT_APP_URL = "https://family-events.up.railway.app"

export interface DigestSummary {
  emailed: number
  skipped: number
  failed: number
  telegramSent: number
  telegramFailed: number
  telegramSkipped: number
}

function emptySummary(): DigestSummary {
  return {
    emailed: 0,
    skipped: 0,
    failed: 0,
    telegramSent: 0,
    telegramFailed: 0,
    telegramSkipped: 0,
  }
}

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name)

  constructor(
    private readonly repository: DigestRepository,
    private readonly plans: PlanRepository,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
    private readonly telegram: TelegramService
  ) {}

  async processRun(now: Date, testEmail?: string): Promise<DigestSummary> {
    const normalizedTestEmail = testEmail?.trim().toLowerCase()
    if (testEmail !== undefined) {
      if (!normalizedTestEmail) throw new Error("digest testEmail must not be blank")
      const user = await this.repository.findDigestUserByEmail(normalizedTestEmail)
      if (!user) return emptySummary()
      // The existing test-email operation must never send to a stored Telegram destination.
      return this.processUsers([user], now, true)
    }

    const summary = emptySummary()
    let after: string | null = null
    while (true) {
      const users = await this.repository.listDigestUsers(after, PAGE_SIZE)
      const page = await this.processUsers(users, now)
      for (const key of Object.keys(summary) as (keyof DigestSummary)[]) {
        summary[key] += page[key]
      }
      if (users.length < PAGE_SIZE) break
      const nextAfter = users.at(-1)?.userId
      if (!nextAfter || nextAfter === after) {
        throw new Error("digest user pagination cursor did not advance")
      }
      after = nextAfter
    }
    return summary
  }

  private async processUsers(
    users: DigestUser[],
    now: Date,
    emailOnly = false
  ): Promise<DigestSummary> {
    const weekend = weekendWindowUtc(now, DIGEST_TZ)
    const dateFrom = new Date(Math.max(now.getTime(), weekend.from.getTime())).toISOString()
    const dateTo = weekend.to.toISOString()
    const appUrl = (this.config.get("APP_URL", { infer: true }) ?? DEFAULT_APP_URL).replace(
      /\/+$/,
      ""
    )
    const summary = emptySummary()

    for (const user of users) {
      const emailEnabled = user.digestEmail
      const telegramEnabled = !emailOnly && user.digestTelegram
      if (!emailEnabled && !telegramEnabled) continue
      let events: DigestEvent[]
      try {
        const planned = await this.plans.planForRange({
          userKey: user.userId,
          dateFrom,
          dateTo,
          cityIds: user.cityIds,
          lat: user.lat,
          lng: user.lng,
          kidAge: user.childAge,
          weatherFit: "neutral",
          limit: 5,
        })
        if (planned.length === 0) {
          if (emailEnabled) summary.skipped += 1
          if (telegramEnabled) summary.telegramSkipped += 1
          continue
        }
        events = planned.map((event) => ({
          id: event.event_id,
          title: event.title,
          startDatetime: event.start_datetime,
          venueName: event.venue_name,
          address: event.address,
          isFree: event.is_free,
          price: event.price,
          images: event.images,
          explanation: buildExplanation(event),
        }))
      } catch {
        if (emailEnabled) summary.failed += 1
        if (telegramEnabled) summary.telegramFailed += 1
        this.logger.warn("digest delivery failed: planning_or_render_error")
        continue
      }

      if (emailEnabled) {
        if (!user.email?.trim()) {
          summary.skipped += 1
        } else {
          try {
            const rendered = renderDigestEmail({ user, events, appUrl })
            const result = await this.mail.send({
              to: user.email,
              subject: rendered.subject,
              html: rendered.html,
            })
            if (result.sent) summary.emailed += 1
            else if (result.dev) summary.skipped += 1
            else summary.failed += 1
          } catch {
            summary.failed += 1
            this.logger.warn("digest email delivery failed")
          }
        }
      }

      if (telegramEnabled) {
        try {
          const response = await this.telegram.send({
            chatId: user.telegramChatId,
            text: renderDigestTelegram({ user, events, appUrl }),
          })
          if (response.sent) summary.telegramSent += 1
          else if (response.reason === "missing_configuration") summary.telegramSkipped += 1
          else summary.telegramFailed += 1
        } catch {
          summary.telegramFailed += 1
          this.logger.warn("digest Telegram delivery failed")
        }
      }
    }
    return summary
  }
}
