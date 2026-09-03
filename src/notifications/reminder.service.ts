import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import { zonedDayStartUtc } from "../pipeline/zoned-time.js"
import { MailService } from "./mail.service.js"
import { ReminderRepository, type ReminderTarget } from "./reminder.repository.js"

const REMINDER_TZ = "America/Chicago"
const DEFAULT_APP_URL = "https://family-events.up.railway.app"
const REMINDER_TEMPLATE_ID = "family-events-event-reminder"

type ReminderType = "day_before" | "morning_of"

function formatEventDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString("en-US", {
      timeZone: REMINDER_TZ,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  } catch {
    return isoDate
  }
}

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name)

  constructor(
    private readonly repository: ReminderRepository,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>
  ) {}

  async processRun(now: Date): Promise<{ emailed: number; skipped: number }> {
    const todayStart = zonedDayStartUtc(now, REMINDER_TZ, 0)
    const todayEnd = zonedDayStartUtc(now, REMINDER_TZ, 1)
    const tomorrowEnd = zonedDayStartUtc(now, REMINDER_TZ, 2)
    const [morningOf, dayBefore] = await Promise.all([
      this.repository.findReminderTargets({
        windowStart: todayStart.toISOString(),
        windowEnd: todayEnd.toISOString(),
      }),
      this.repository.findReminderTargets({
        windowStart: todayEnd.toISOString(),
        windowEnd: tomorrowEnd.toISOString(),
      }),
    ])

    let emailed = 0
    let skipped = 0
    const seen = new Set<string>()
    for (const [targets, type] of [
      [morningOf, "morning_of"],
      [dayBefore, "day_before"],
    ] as const) {
      for (const target of targets) {
        const dedupKey = `${target.userId}:${target.eventId}:${type}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        if (target.reminderEmail === false) {
          skipped += 1
          continue
        }
        await this.sendReminder(target, type)
        // MailService soft-fails by contract. This summary tracks attempted
        // recipient emails; delivery acceptance is logged by MailService.
        emailed += 1
      }
    }
    return { emailed, skipped }
  }

  private async sendReminder(target: ReminderTarget, type: ReminderType): Promise<void> {
    const appUrl = (this.config.get("APP_URL", { infer: true }) ?? DEFAULT_APP_URL).replace(
      /\/+$/,
      ""
    )
    const reminderLabel = type === "day_before" ? "tomorrow" : "today"
    const result = await this.mail.send({
      to: target.email,
      subject: `Reminder: ${target.title} is ${reminderLabel}`,
      templateId: REMINDER_TEMPLATE_ID,
      variables: {
        USERNAME: target.displayName || "there",
        EVENT_TITLE: target.title,
        EVENT_DATE: formatEventDate(target.startDatetime),
        EVENT_LOCATION: target.venueName || target.address || "TBD",
        EVENT_URL: `${appUrl}/events/${target.eventId}`,
        LOGO_URL: `${appUrl}/brand/family-events-logo.png`,
        APP_URL: appUrl,
      },
    })
    if (!result.sent) {
      this.logger.warn(`reminder email was not accepted for ${target.email}`)
    }
  }
}
