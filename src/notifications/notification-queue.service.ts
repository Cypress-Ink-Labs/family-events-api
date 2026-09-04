import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import { MailService } from "./mail.service.js"
import {
  NotificationQueueRepository,
  type InAppNotificationRow,
  type NotificationChangeType,
  type NotificationEventRow,
  type NotificationProfileRow,
  type NotificationQueueEntry,
} from "./notification-queue.repository.js"
import { PushService } from "./push.service.js"

const DEBOUNCE_MS = 60 * 60 * 1_000
const DEFAULT_APP_URL = "https://family-events.up.railway.app"
const CHANGE_TEMPLATE_ID = "family-events-event-change"
const NOTIFICATION_TIME_ZONE = "America/Chicago"

export interface ChannelCounts {
  sent: number
  failed: number
  skipped: number
}

export interface NotificationQueueRunResult {
  ok: boolean
  lockAcquired: boolean
  skipped: boolean
  skipReason: "lock_not_acquired" | null
  processed: number
  refreshed: number
  persistenceFailed: boolean
  channels: {
    email: ChannelCounts
    inApp: ChannelCounts
    push: ChannelCounts & { pruned: number; unmatchedRecipients: number }
  }
}

interface PreparedNotification {
  entry: NotificationQueueEntry
  event: NotificationEventRow
  profile: NotificationProfileRow & { email: string }
  changeEmail: boolean
  changePush: boolean
  title: string
  summary: string
  eventUrl: string
}

interface PushGroup {
  title: string
  body: string
  url: string
  userIds: string[]
}

function emptyCounts(): ChannelCounts {
  return { sent: 0, failed: 0, skipped: 0 }
}

function emptyResult(): NotificationQueueRunResult {
  return {
    ok: true,
    lockAcquired: true,
    skipped: false,
    skipReason: null,
    processed: 0,
    refreshed: 0,
    persistenceFailed: false,
    channels: {
      email: emptyCounts(),
      inApp: emptyCounts(),
      push: { ...emptyCounts(), pruned: 0, unmatchedRecipients: 0 },
    },
  }
}

export function formatNotificationEventDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString("en-US", {
      timeZone: NOTIFICATION_TIME_ZONE,
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

export function buildChangeSummary(
  changeType: NotificationChangeType,
  detail: Record<string, unknown> | null
): string {
  switch (changeType) {
    case "cancelled":
      return "This event has been cancelled."
    case "time_changed":
      return typeof detail?.new_start === "string"
        ? `Time changed to ${formatNotificationEventDate(detail.new_start)}`
        : "The event time has changed."
    case "venue_changed":
      return typeof detail?.new_venue === "string"
        ? `Venue changed to ${detail.new_venue}`
        : "The event venue has changed."
    case "status_changed":
      return "The event status has been updated."
  }
}

function notificationTitle(changeType: NotificationChangeType, eventTitle: string): string {
  return changeType === "cancelled" ? `Cancelled: ${eventTitle}` : `Updated: ${eventTitle}`
}

@Injectable()
export class NotificationQueueService {
  private readonly logger = new Logger(NotificationQueueService.name)

  constructor(
    private readonly repository: NotificationQueueRepository,
    private readonly mail: MailService,
    private readonly push: PushService,
    private readonly config: ConfigService<Env, true>
  ) {}

  async processRun(now: Date): Promise<NotificationQueueRunResult> {
    const exclusive = await this.repository.withExclusiveRun(() => this.processExclusiveRun(now))
    if (!exclusive.acquired) {
      return {
        ...emptyResult(),
        lockAcquired: false,
        skipped: true,
        skipReason: "lock_not_acquired",
      }
    }
    return exclusive.value
  }

  private async processExclusiveRun(now: Date): Promise<NotificationQueueRunResult> {
    const result = emptyResult()
    const cutoff = new Date(now.getTime() - DEBOUNCE_MS).toISOString()
    const entries = await this.repository.listPending(cutoff)
    if (entries.length === 0) return result

    const eventIds = [...new Set(entries.map((entry) => entry.eventId))]
    const userIds = [...new Set(entries.map((entry) => entry.userId))]

    // Hydration is intentionally complete before the first delivery side effect.
    const events = await this.repository.hydrateEvents(eventIds)
    const profiles = await this.repository.hydrateProfiles(userIds)
    const preferences = await this.repository.hydratePreferences(userIds)

    const eventById = new Map(events.map((event) => [event.id, event]))
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]))
    const preferenceByUser = new Map(
      preferences.map((preference) => [preference.userId, preference])
    )
    const appUrl = (this.config.get("APP_URL", { infer: true }) ?? DEFAULT_APP_URL).replace(
      /\/+$/,
      ""
    )
    const prepared: PreparedNotification[] = []

    for (const entry of entries) {
      const event = eventById.get(entry.eventId)
      const profile = profileById.get(entry.userId)
      if (!event || !profile?.email) {
        result.channels.email.skipped++
        result.channels.inApp.skipped++
        result.channels.push.skipped++
        continue
      }
      const preference = preferenceByUser.get(entry.userId)
      const summary = buildChangeSummary(entry.changeType, entry.changeDetail)
      prepared.push({
        entry,
        event,
        profile: { ...profile, email: profile.email },
        changeEmail: preference?.changeEmail ?? true,
        changePush: preference?.changePush ?? true,
        title: notificationTitle(entry.changeType, event.title),
        summary,
        eventUrl: `${appUrl}/events/${entry.eventId}`,
      })
    }

    await this.sendEmails(prepared, result.channels.email)
    await this.insertInApp(prepared, result.channels.inApp)
    await this.sendPushes(prepared, result.channels.push)

    try {
      result.processed = await this.repository.markProcessed(entries, now.toISOString())
      result.refreshed = entries.length - result.processed
    } catch {
      result.ok = false
      result.persistenceFailed = true
      this.logger.error(`notification marker failed: category=database count=${entries.length}`)
    }
    return result
  }

  private async sendEmails(prepared: PreparedNotification[], counts: ChannelCounts): Promise<void> {
    for (const item of prepared) {
      if (!item.changeEmail) {
        counts.skipped++
        continue
      }
      try {
        const response = await this.mail.send({
          to: item.profile.email,
          subject: item.title,
          templateId: CHANGE_TEMPLATE_ID,
          variables: {
            USERNAME: item.profile.displayName || "there",
            EVENT_TITLE: item.event.title,
            CHANGE_SUMMARY: item.summary,
            EVENT_DATE: formatNotificationEventDate(item.event.startDatetime),
            EVENT_LOCATION: item.event.venueName || item.event.address || "TBD",
            EVENT_URL: item.eventUrl,
          },
        })
        if (response.sent) counts.sent++
        else if (response.dev) counts.skipped++
        else counts.failed++
      } catch {
        counts.failed++
        this.logger.warn("notification email failed: category=internal")
      }
    }
  }

  private async insertInApp(
    prepared: PreparedNotification[],
    counts: ChannelCounts
  ): Promise<void> {
    const rows: InAppNotificationRow[] = prepared.map((item) => ({
      userId: item.entry.userId,
      type: "change",
      title: item.title,
      body: item.summary,
      eventId: item.entry.eventId,
    }))
    if (rows.length === 0) return
    try {
      await this.repository.insertInAppNotifications(rows)
      counts.sent += rows.length
    } catch {
      this.logger.warn(`in-app bulk insert failed: category=database count=${rows.length}`)
      for (const row of rows) {
        try {
          await this.repository.insertInAppNotification(row)
          counts.sent++
        } catch {
          counts.failed++
          this.logger.warn("in-app row insert failed: category=database count=1")
        }
      }
    }
  }

  private async sendPushes(
    prepared: PreparedNotification[],
    counts: ChannelCounts & { pruned: number; unmatchedRecipients: number }
  ): Promise<void> {
    const groups = new Map<string, PushGroup>()
    for (const item of prepared) {
      if (!item.changePush) {
        counts.skipped++
        continue
      }
      const key = `${item.entry.eventId}:${item.entry.changeType}`
      const existing = groups.get(key)
      if (existing) {
        if (!existing.userIds.includes(item.entry.userId)) existing.userIds.push(item.entry.userId)
      } else {
        groups.set(key, {
          title: item.title,
          body: item.summary,
          url: item.eventUrl,
          userIds: [item.entry.userId],
        })
      }
    }

    for (const group of groups.values()) {
      try {
        const response = await this.push.send(group)
        counts.sent += response.sent
        counts.failed += response.failed
        counts.skipped += response.skipped
        counts.pruned += response.pruned
        counts.unmatchedRecipients += response.unmatchedRecipients
      } catch {
        counts.failed += group.userIds.length
        this.logger.warn(
          `notification push failed: category=internal count=${group.userIds.length}`
        )
      }
    }
  }
}
