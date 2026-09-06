import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"

import { Injectable, Logger, Optional } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import { zonedDayStartUtc } from "../pipeline/zoned-time.js"
import { MailService } from "./mail.service.js"
import { PushService } from "./push.service.js"
import {
  ReminderRepository,
  type ReminderInAppNotificationRow,
  type ReminderTarget,
} from "./reminder.repository.js"

const REMINDER_TZ = "America/Chicago"
const DEFAULT_APP_URL = "https://family-events.up.railway.app"
const REMINDER_TEMPLATE_ID = "family-events-event-reminder"
const REMINDER_BATCH_SIZE = 10
const REMINDER_BATCH_DELAY_MS = 300

export interface ReminderDependencies {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

type ReminderType = "day_before" | "morning_of"

function reminderNotificationId(target: ReminderTarget, type: ReminderType): string {
  const bytes = createHash("sha256")
    .update(`${target.userId}:${target.eventId}:${target.startDatetime}:${type}`)
    .digest()
    .subarray(0, 16)
  // Encode the stable hash as an RFC 4122 variant/version UUID so Postgres
  // can enforce idempotency through the existing primary key.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface ReminderChannelCounts {
  sent: number
  failed: number
  skipped: number
}

export interface ReminderRunResult {
  total: number
  channels: {
    email: ReminderChannelCounts
    inApp: ReminderChannelCounts
    push: {
      sentSubscriptions: number
      failedSubscriptions: number
      skippedSubscriptions: number
      prunedSubscriptions: number
      unmatchedRecipients: number
      skippedRecipients: number
      failedDispatches: number
      failedBatches: number
      failedBatchRecipients: number
    }
  }
}

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
    private readonly config: ConfigService<Env, true>,
    private readonly push: PushService,
    @Optional() private readonly dependencies: ReminderDependencies = {}
  ) {}

  async processRun(now: Date, signal?: AbortSignal): Promise<ReminderRunResult> {
    signal?.throwIfAborted()
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

    signal?.throwIfAborted()
    const result: ReminderRunResult = {
      total: 0,
      channels: {
        email: { sent: 0, failed: 0, skipped: 0 },
        inApp: { sent: 0, failed: 0, skipped: 0 },
        push: {
          sentSubscriptions: 0,
          failedSubscriptions: 0,
          skippedSubscriptions: 0,
          prunedSubscriptions: 0,
          unmatchedRecipients: 0,
          skippedRecipients: 0,
          failedDispatches: 0,
          failedBatches: 0,
          failedBatchRecipients: 0,
        },
      },
    }
    const prepared: { target: ReminderTarget; type: ReminderType }[] = []
    const pushContext = this.push.createSendContext()
    const seen = new Set<string>()
    for (const [targets, type] of [
      [morningOf, "morning_of"],
      [dayBefore, "day_before"],
    ] as const) {
      for (const target of targets) {
        const dedupKey = `${target.userId}:${target.eventId}:${type}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        prepared.push({ target, type })
      }
    }
    result.total = prepared.length
    // Repository order and the fixed morning/tomorrow order keep batches deterministic.
    for (let offset = 0; offset < prepared.length; offset += REMINDER_BATCH_SIZE) {
      signal?.throwIfAborted()
      const inAppRows: ReminderInAppNotificationRow[] = []
      for (const { target, type } of prepared.slice(offset, offset + REMINDER_BATCH_SIZE)) {
        signal?.throwIfAborted()
        const title = `Reminder: ${target.title} is ${type === "day_before" ? "tomorrow" : "today"}`
        const body = `${formatEventDate(target.startDatetime)}${target.venueName ? ` at ${target.venueName}` : ""}`
        inAppRows.push({
          id: reminderNotificationId(target, type),
          userId: target.userId,
          eventId: target.eventId,
          type: "reminder",
          title,
          body,
        })

        if (target.reminderEmail === false || !target.email?.trim()) {
          result.channels.email.skipped += 1
        } else {
          try {
            const response = await this.sendReminder(
              { ...target, email: target.email },
              type,
              signal
            )
            signal?.throwIfAborted()
            if (response.sent) result.channels.email.sent += 1
            else if (response.dev) result.channels.email.skipped += 1
            else result.channels.email.failed += 1
          } catch {
            signal?.throwIfAborted()
            result.channels.email.failed += 1
            this.logger.warn("reminder email delivery failed: internal_error")
          }
        }

        signal?.throwIfAborted()
        if (target.reminderPush === false) {
          result.channels.push.skippedRecipients += 1
        } else {
          try {
            const response = await this.push.send(
              {
                userIds: [target.userId],
                title,
                body,
                url: `${this.appUrl()}/events/${target.eventId}`,
              },
              pushContext,
              signal
            )
            signal?.throwIfAborted()
            result.channels.push.sentSubscriptions += response.sent
            result.channels.push.failedSubscriptions += response.failed
            result.channels.push.skippedSubscriptions += response.skipped
            result.channels.push.prunedSubscriptions += response.pruned
            result.channels.push.unmatchedRecipients += response.unmatchedRecipients
            result.channels.push.failedBatches += response.failedBatches
            result.channels.push.failedBatchRecipients += response.failedBatchRecipients
          } catch {
            signal?.throwIfAborted()
            result.channels.push.failedBatches += 1
            result.channels.push.failedBatchRecipients += 1
            result.channels.push.failedDispatches += 1
            this.logger.warn("reminder push delivery failed: internal_error")
          }
        }
      }
      await this.writeInApp(inAppRows, result.channels.inApp, signal)
      signal?.throwIfAborted()
      if (offset + REMINDER_BATCH_SIZE < prepared.length) {
        if (this.dependencies.sleep) await this.dependencies.sleep(REMINDER_BATCH_DELAY_MS, signal)
        else await delay(REMINDER_BATCH_DELAY_MS, undefined, { signal })
      }
    }
    signal?.throwIfAborted()
    return result
  }

  private async writeInApp(
    rows: ReminderInAppNotificationRow[],
    counts: ReminderChannelCounts,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    if (rows.length === 0) return
    try {
      counts.sent += await this.repository.insertInAppNotifications(rows)
      signal?.throwIfAborted()
    } catch {
      signal?.throwIfAborted()
      this.logger.warn(`reminder in-app bulk insert failed: category=database count=${rows.length}`)
      for (const row of rows) {
        signal?.throwIfAborted()
        try {
          counts.sent += await this.repository.insertInAppNotification(row)
          signal?.throwIfAborted()
        } catch {
          signal?.throwIfAborted()
          counts.failed += 1
          this.logger.warn("reminder in-app row insert failed: category=database count=1")
        }
      }
    }
  }

  private appUrl(): string {
    return (this.config.get("APP_URL", { infer: true }) ?? DEFAULT_APP_URL).replace(/\/+$/, "")
  }

  private async sendReminder(
    target: ReminderTarget & { email: string },
    type: ReminderType,
    signal?: AbortSignal
  ) {
    const appUrl = this.appUrl()
    const reminderLabel = type === "day_before" ? "tomorrow" : "today"
    const result = await this.mail.send({
      ...(signal ? { signal } : {}),
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
      this.logger.warn("reminder email was not accepted")
    }
    return result
  }
}
