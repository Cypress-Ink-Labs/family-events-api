import { ConfigService } from "@nestjs/config"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import type { MailService, SendMailResult } from "./mail.service.js"
import type { PushService, SendPushResult } from "./push.service.js"
import type {
  ReminderInAppNotificationRow,
  ReminderRepository,
  ReminderTarget,
} from "./reminder.repository.js"
import { ReminderService } from "./reminder.service.js"

const target: ReminderTarget = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "reader@example.com",
  displayName: "Reader",
  eventId: "22222222-2222-4222-8222-222222222222",
  title: "Storytime",
  startDatetime: "2026-08-16T15:30:00.000Z",
  venueName: "Main Library",
  address: "100 Main St",
  reminderEmail: true,
  reminderPush: true,
}

function makeService() {
  const repository = {
    findReminderTargets: vi.fn(async () => [] as ReminderTarget[]),
    insertInAppNotifications: vi.fn(async (rows: ReminderInAppNotificationRow[]) => rows.length),
    insertInAppNotification: vi.fn(async (_row: ReminderInAppNotificationRow) => 1),
  }
  const mail = {
    send: vi.fn(async (): Promise<SendMailResult> => ({ sent: true, status: 200 })),
  }
  const config = {
    get: (key: keyof Env) => (key === "APP_URL" ? "https://events.example.com/" : undefined),
  } as ConfigService<Env, true>
  const push = {
    createSendContext: vi.fn(() => ({ subscriptions: new Map() })),
    send: vi.fn(async (): Promise<SendPushResult> => ({
      requestedRecipients: 1,
      matchedRecipients: 1,
      unmatchedRecipients: 0,
      failedBatches: 0,
      failedBatchRecipients: 0,
      sent: 1,
      failed: 0,
      pruned: 0,
      skipped: 0,
    })),
  }
  return {
    service: new ReminderService(
      repository as unknown as ReminderRepository,
      mail as unknown as MailService,
      config,
      push as unknown as PushService
    ),
    repository,
    mail,
    push,
  }
}

function successfulChannels(sent: number) {
  return {
    email: { sent, failed: 0, skipped: 0 },
    inApp: { sent, failed: 0, skipped: 0 },
    push: {
      sentSubscriptions: sent,
      failedSubscriptions: 0,
      skippedSubscriptions: 0,
      prunedSubscriptions: 0,
      unmatchedRecipients: 0,
      failedBatches: 0,
      failedBatchRecipients: 0,
      skippedRecipients: 0,
      failedDispatches: 0,
    },
  }
}

describe("ReminderService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("queries exact Chicago morning-of and day-before windows", async () => {
    const { service, repository } = makeService()
    await service.processRun(new Date("2026-08-16T16:00:00Z"))

    expect(repository.findReminderTargets).toHaveBeenNthCalledWith(1, {
      windowStart: "2026-08-16T05:00:00.000Z",
      windowEnd: "2026-08-17T05:00:00.000Z",
    })
    expect(repository.findReminderTargets).toHaveBeenNthCalledWith(2, {
      windowStart: "2026-08-17T05:00:00.000Z",
      windowEnd: "2026-08-18T05:00:00.000Z",
    })
  })

  it("deduplicates duplicate user/event/type targets within one run", async () => {
    const { service, repository, mail } = makeService()
    repository.findReminderTargets.mockResolvedValueOnce([target, target]).mockResolvedValueOnce([])

    await expect(service.processRun(new Date("2026-08-16T16:00:00Z"))).resolves.toEqual({
      total: 1,
      channels: successfulChannels(1),
    })
    expect(mail.send).toHaveBeenCalledTimes(1)
  })

  it("keeps every target in-app while channel preferences remain independent", async () => {
    const { service, repository, mail, push } = makeService()
    repository.findReminderTargets.mockResolvedValueOnce([
      { ...target, reminderEmail: false, reminderPush: false },
      {
        ...target,
        eventId: "33333333-3333-4333-8333-333333333333",
        reminderEmail: null,
        reminderPush: null,
      },
      {
        ...target,
        eventId: "44444444-4444-4444-8444-444444444444",
        email: null,
      },
    ])

    await expect(service.processRun(new Date("2026-08-16T16:00:00Z"))).resolves.toEqual({
      total: 3,
      channels: {
        email: { sent: 1, failed: 0, skipped: 2 },
        inApp: { sent: 3, failed: 0, skipped: 0 },
        push: {
          sentSubscriptions: 2,
          failedSubscriptions: 0,
          skippedSubscriptions: 0,
          prunedSubscriptions: 0,
          unmatchedRecipients: 0,
          failedBatches: 0,
          failedBatchRecipients: 0,
          skippedRecipients: 1,
          failedDispatches: 0,
        },
      },
    })
    expect(mail.send).toHaveBeenCalledTimes(1)
    expect(push.send).toHaveBeenCalledTimes(2)
    expect(repository.insertInAppNotifications.mock.calls[0]?.[0]).toHaveLength(3)
  })

  it("sends the hosted template and matching push payload", async () => {
    const { service, repository, mail, push } = makeService()
    repository.findReminderTargets.mockResolvedValueOnce([target])

    await service.processRun(new Date("2026-08-16T16:00:00Z"))

    expect(mail.send).toHaveBeenCalledWith({
      to: "reader@example.com",
      subject: "Reminder: Storytime is today",
      templateId: "family-events-event-reminder",
      variables: {
        USERNAME: "Reader",
        EVENT_TITLE: "Storytime",
        EVENT_DATE: "Sunday, August 16 at 10:30 AM",
        EVENT_LOCATION: "Main Library",
        EVENT_URL: "https://events.example.com/events/22222222-2222-4222-8222-222222222222",
        LOGO_URL: "https://events.example.com/brand/family-events-logo.png",
        APP_URL: "https://events.example.com",
      },
    })
    expect(push.send).toHaveBeenCalledWith(
      {
        userIds: [target.userId],
        title: "Reminder: Storytime is today",
        body: "Sunday, August 16 at 10:30 AM at Main Library",
        url: "https://events.example.com/events/22222222-2222-4222-8222-222222222222",
      },
      expect.any(Object),
      undefined
    )
  })

  it("reports missing mail configuration as a channel skip", async () => {
    const { service, repository, mail } = makeService()
    repository.findReminderTargets.mockResolvedValueOnce([target])
    mail.send.mockResolvedValueOnce({ sent: false, dev: true })

    await expect(service.processRun(new Date("2026-08-16T16:00:00Z"))).resolves.toEqual({
      total: 1,
      channels: {
        ...successfulChannels(1),
        email: { sent: 0, failed: 0, skipped: 1 },
      },
    })
  })

  it("isolates channel failures and falls back to individual in-app inserts", async () => {
    const { service, repository, mail, push } = makeService()
    repository.findReminderTargets.mockResolvedValueOnce([
      target,
      { ...target, eventId: "33333333-3333-4333-8333-333333333333" },
    ])
    mail.send.mockRejectedValueOnce(new Error("mail unavailable"))
    push.send.mockRejectedValueOnce(new Error("push unavailable"))
    repository.insertInAppNotifications.mockRejectedValueOnce(new Error("bulk unavailable"))
    repository.insertInAppNotification
      .mockRejectedValueOnce(new Error("row unavailable"))
      .mockResolvedValueOnce(1)

    await expect(service.processRun(new Date("2026-08-16T16:00:00Z"))).resolves.toEqual({
      total: 2,
      channels: {
        email: { sent: 1, failed: 1, skipped: 0 },
        inApp: { sent: 1, failed: 1, skipped: 0 },
        push: {
          sentSubscriptions: 1,
          failedSubscriptions: 0,
          skippedSubscriptions: 0,
          prunedSubscriptions: 0,
          unmatchedRecipients: 0,
          failedBatches: 1,
          failedBatchRecipients: 1,
          skippedRecipients: 0,
          failedDispatches: 1,
        },
      },
    })
    expect(repository.insertInAppNotification).toHaveBeenCalledTimes(2)
  })

  it("reports push recipient and subscription outcomes in separate units", async () => {
    const { service, repository, push } = makeService()
    repository.findReminderTargets.mockResolvedValueOnce([target])
    push.send.mockResolvedValueOnce({
      requestedRecipients: 1,
      matchedRecipients: 1,
      unmatchedRecipients: 0,
      failedBatches: 0,
      failedBatchRecipients: 0,
      sent: 2,
      failed: 1,
      pruned: 1,
      skipped: 1,
    })

    const result = await service.processRun(new Date("2026-08-16T16:00:00Z"))
    expect(result.channels.push).toEqual({
      sentSubscriptions: 2,
      failedSubscriptions: 1,
      skippedSubscriptions: 1,
      prunedSubscriptions: 1,
      unmatchedRecipients: 0,
      failedBatches: 0,
      failedBatchRecipients: 0,
      skippedRecipients: 0,
      failedDispatches: 0,
    })
  })
})
