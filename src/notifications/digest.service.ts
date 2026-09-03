import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import { PlanRepository } from "../data/plan.repository.js"
import { weekendWindowUtc } from "../pipeline/zoned-time.js"
import { buildExplanation, renderDigestEmail, type DigestEvent } from "./digest-html.js"
import { DigestRepository, type DigestUser } from "./digest.repository.js"
import { MailService } from "./mail.service.js"

const DIGEST_TZ = "America/Chicago"
const PAGE_SIZE = 1000
const DEFAULT_APP_URL = "https://family-events.up.railway.app"

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name)

  constructor(
    private readonly repository: DigestRepository,
    private readonly plans: PlanRepository,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>
  ) {}

  async processRun(
    now: Date,
    testEmail?: string
  ): Promise<{ emailed: number; skipped: number; failed: number }> {
    const normalizedTestEmail = testEmail?.trim().toLowerCase()
    if (normalizedTestEmail) {
      const user = await this.repository.findDigestUserByEmail(normalizedTestEmail)
      if (!user) return { emailed: 0, skipped: 0, failed: 0 }
      return this.processUsers([user], now)
    }

    let emailed = 0
    let skipped = 0
    let failed = 0
    let after: string | null = null
    while (true) {
      const users = await this.repository.listDigestUsers(after, PAGE_SIZE)
      const page = await this.processUsers(users, now)
      emailed += page.emailed
      skipped += page.skipped
      failed += page.failed
      if (users.length < PAGE_SIZE) break
      const nextAfter = users.at(-1)?.userId
      if (!nextAfter || nextAfter === after) {
        throw new Error("digest user pagination cursor did not advance")
      }
      after = nextAfter
    }
    return { emailed, skipped, failed }
  }

  private async processUsers(
    users: DigestUser[],
    now: Date
  ): Promise<{ emailed: number; skipped: number; failed: number }> {
    const weekend = weekendWindowUtc(now, DIGEST_TZ)
    const dateFrom = new Date(Math.max(now.getTime(), weekend.from.getTime())).toISOString()
    const dateTo = weekend.to.toISOString()
    const appUrl = (this.config.get("APP_URL", { infer: true }) ?? DEFAULT_APP_URL).replace(
      /\/+$/,
      ""
    )
    let emailed = 0
    let skipped = 0
    let failed = 0

    for (const user of users) {
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
          skipped += 1
          continue
        }
        const events: DigestEvent[] = planned.map((event) => ({
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
        const rendered = renderDigestEmail({ user, events, appUrl })
        const result = await this.mail.send({
          to: user.email,
          subject: rendered.subject,
          html: rendered.html,
        })
        if (result.sent) emailed += 1
        else failed += 1
      } catch (error) {
        failed += 1
        this.logger.warn(
          `digest failed for user ${user.userId}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    return { emailed, skipped, failed }
  }
}
