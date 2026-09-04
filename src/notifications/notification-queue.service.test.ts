import { ConfigService } from "@nestjs/config"
import { describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import type { SendMailResult } from "./mail.service.js"
import type {
  InAppNotificationRow,
  NotificationEventRow,
  NotificationPreferenceRow,
  NotificationProfileRow,
  NotificationQueueEntry,
  NotificationQueueRepository,
} from "./notification-queue.repository.js"
import { buildChangeSummary, NotificationQueueService } from "./notification-queue.service.js"
import type { PushService, SendPushResult } from "./push.service.js"

const NOW = new Date("2026-09-05T15:00:00.000Z")
const EVENT_ID = "11111111-1111-4111-8111-111111111111"
const USER_ID = "22222222-2222-4222-8222-222222222222"

function entry(overrides: Partial<NotificationQueueEntry> = {}): NotificationQueueEntry {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    userId: USER_ID,
    eventId: EVENT_ID,
    changeType: "time_changed",
    changeDetail: { new_start: "2026-09-06T16:30:00.000Z" },
    createdAt: "2026-09-05T13:00:00.000Z",
    ...overrides,
  }
}

function event(overrides: Partial<NotificationEventRow> = {}): NotificationEventRow {
  return {
    id: EVENT_ID,
    title: "Storytime",
    startDatetime: "2026-09-06T16:30:00.000Z",
    venueName: "Main Library",
    address: "100 Main St",
    status: "published",
    ...overrides,
  }
}

function profile(overrides: Partial<NotificationProfileRow> = {}): NotificationProfileRow {
  return {
    id: USER_ID,
    email: "reader@example.com",
    displayName: "Reader",
    ...overrides,
  }
}

function preference(overrides: Partial<NotificationPreferenceRow> = {}): NotificationPreferenceRow {
  return { userId: USER_ID, changeEmail: true, changePush: true, ...overrides }
}

function makeHarness(
  input: {
    entries?: NotificationQueueEntry[]
    events?: NotificationEventRow[]
    profiles?: NotificationProfileRow[]
    preferences?: NotificationPreferenceRow[]
    appUrl?: string
  } = {}
) {
  const entries = input.entries ?? [entry()]
  const repository = {
    listPending: vi.fn(async () => entries),
    hydrateEvents: vi.fn(async () => input.events ?? [event()]),
    hydrateProfiles: vi.fn(async () => input.profiles ?? [profile()]),
    hydratePreferences: vi.fn(async () => input.preferences ?? [preference()]),
    insertInAppNotifications: vi.fn(async (_rows: InAppNotificationRow[]) => undefined),
    insertInAppNotification: vi.fn(async (_row: InAppNotificationRow) => undefined),
    markProcessed: vi.fn(async () => undefined),
  }
  const mail = {
    send: vi.fn(async (): Promise<SendMailResult> => ({ sent: true, status: 200 })),
  }
  const push = {
    send: vi.fn(async (): Promise<SendPushResult> => ({
      sent: 1,
      failed: 0,
      pruned: 0,
      skipped: 0,
    })),
  }
  const config = {
    get: (key: keyof Env) =>
      key === "APP_URL" ? (input.appUrl ?? "https://events.example.com/") : undefined,
  } as ConfigService<Env, true>
  return {
    service: new NotificationQueueService(
      repository as unknown as NotificationQueueRepository,
      mail as never,
      push as unknown as PushService,
      config
    ),
    repository,
    mail,
    push,
  }
}

describe("buildChangeSummary", () => {
  it("preserves all legacy summary variants", () => {
    expect(buildChangeSummary("cancelled", null)).toBe("This event has been cancelled.")
    expect(buildChangeSummary("time_changed", { new_start: "2026-09-06T16:30:00.000Z" })).toBe(
      "Time changed to Sunday, September 6 at 11:30 AM"
    )
    expect(buildChangeSummary("time_changed", null)).toBe("The event time has changed.")
    expect(buildChangeSummary("venue_changed", { new_venue: "North Branch" })).toBe(
      "Venue changed to North Branch"
    )
    expect(buildChangeSummary("venue_changed", null)).toBe("The event venue has changed.")
    expect(buildChangeSummary("status_changed", null)).toBe("The event status has been updated.")
  })
})

describe("NotificationQueueService", () => {
  it("uses the exact one-hour cutoff", async () => {
    const { service, repository } = makeHarness({ entries: [] })

    await service.processRun(NOW)

    expect(repository.listPending).toHaveBeenCalledWith("2026-09-05T14:00:00.000Z")
  })

  it.each(["hydrateEvents", "hydrateProfiles", "hydratePreferences"] as const)(
    "lets %s failures throw before every side effect",
    async (method) => {
      const { service, repository, mail, push } = makeHarness()
      repository[method].mockRejectedValueOnce(new Error(`${method} raw secret`))

      await expect(service.processRun(NOW)).rejects.toThrow()
      expect(mail.send).not.toHaveBeenCalled()
      expect(push.send).not.toHaveBeenCalled()
      expect(repository.insertInAppNotifications).not.toHaveBeenCalled()
      expect(repository.insertInAppNotification).not.toHaveBeenCalled()
      expect(repository.markProcessed).not.toHaveBeenCalled()
    }
  )

  it("defaults both delivery preferences to true only after successful empty hydration", async () => {
    const { service, repository, mail, push } = makeHarness({ preferences: [] })

    const result = await service.processRun(NOW)

    expect(mail.send).toHaveBeenCalledTimes(1)
    expect(push.send).toHaveBeenCalledTimes(1)
    expect(repository.insertInAppNotifications).toHaveBeenCalledTimes(1)
    expect(result.channels).toEqual({
      email: { sent: 1, failed: 0, skipped: 0 },
      inApp: { sent: 1, failed: 0, skipped: 0 },
      push: { sent: 1, failed: 0, skipped: 0, pruned: 0 },
    })
  })

  it("marks missing event, profile, and email entries while skipping every channel", async () => {
    const missingEvent = entry({ id: "30000000-0000-4000-8000-000000000001" })
    const missingProfile = entry({
      id: "30000000-0000-4000-8000-000000000002",
      eventId: "10000000-0000-4000-8000-000000000002",
      userId: "20000000-0000-4000-8000-000000000002",
    })
    const missingEmail = entry({
      id: "30000000-0000-4000-8000-000000000003",
      eventId: "10000000-0000-4000-8000-000000000003",
      userId: "20000000-0000-4000-8000-000000000003",
    })
    const { service, repository, mail, push } = makeHarness({
      entries: [missingEvent, missingProfile, missingEmail],
      events: [event({ id: missingProfile.eventId }), event({ id: missingEmail.eventId })],
      profiles: [profile({ id: missingEmail.userId, email: null })],
      preferences: [],
    })

    await expect(service.processRun(NOW)).resolves.toMatchObject({
      ok: true,
      processed: 3,
      persistenceFailed: false,
      channels: {
        email: { sent: 0, failed: 0, skipped: 3 },
        inApp: { sent: 0, failed: 0, skipped: 3 },
        push: { sent: 0, failed: 0, skipped: 3, pruned: 0 },
      },
    })
    expect(mail.send).not.toHaveBeenCalled()
    expect(push.send).not.toHaveBeenCalled()
    expect(repository.markProcessed).toHaveBeenCalledWith(
      [missingEvent.id, missingProfile.id, missingEmail.id],
      NOW.toISOString()
    )
  })

  it("sends the legacy hosted template variables, title, and change summary", async () => {
    const { service, mail } = makeHarness({
      entries: [entry({ changeType: "cancelled", changeDetail: null })],
      profiles: [profile({ displayName: null })],
    })

    await service.processRun(NOW)

    expect(mail.send).toHaveBeenCalledWith({
      to: "reader@example.com",
      subject: "Cancelled: Storytime",
      templateId: "family-events-event-change",
      variables: {
        USERNAME: "there",
        EVENT_TITLE: "Storytime",
        CHANGE_SUMMARY: "This event has been cancelled.",
        EVENT_DATE: "Sunday, September 6 at 11:30 AM",
        EVENT_LOCATION: "Main Library",
        EVENT_URL: "https://events.example.com/events/11111111-1111-4111-8111-111111111111",
      },
    })
  })

  it("groups push once per event and change type", async () => {
    const user2 = "22222222-2222-4222-8222-222222222223"
    const entries = [
      entry(),
      entry({ id: "33333333-3333-4333-8333-333333333334", userId: user2 }),
      entry({ id: "33333333-3333-4333-8333-333333333335", changeType: "venue_changed" }),
    ]
    const { service, push } = makeHarness({
      entries,
      profiles: [profile(), profile({ id: user2, email: "second@example.com" })],
      preferences: [preference(), preference({ userId: user2 })],
    })

    await service.processRun(NOW)

    expect(push.send).toHaveBeenCalledTimes(2)
    expect(push.send).toHaveBeenCalledWith({
      userIds: [USER_ID, user2],
      title: "Updated: Storytime",
      body: "Time changed to Sunday, September 6 at 11:30 AM",
      url: `https://events.example.com/events/${EVENT_ID}`,
    })
    expect(push.send).toHaveBeenCalledWith({
      userIds: [USER_ID],
      title: "Updated: Storytime",
      body: "The event venue has changed.",
      url: `https://events.example.com/events/${EVENT_ID}`,
    })
  })

  it("reports expired subscriptions as pruned rather than failed", async () => {
    const { service, push } = makeHarness()
    push.send.mockResolvedValueOnce({ sent: 0, failed: 0, pruned: 1, skipped: 0 })

    const result = await service.processRun(NOW)

    expect(result.channels.push).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      pruned: 1,
    })
  })

  it("falls back from one failed bulk in-app insert to isolated rows", async () => {
    const second = entry({
      id: "33333333-3333-4333-8333-333333333334",
      userId: "22222222-2222-4222-8222-222222222223",
    })
    const { service, repository } = makeHarness({
      entries: [entry(), second],
      profiles: [profile(), profile({ id: second.userId, email: "second@example.com" })],
      preferences: [preference(), preference({ userId: second.userId })],
    })
    repository.insertInAppNotifications.mockRejectedValueOnce(new Error("bulk raw failure"))
    repository.insertInAppNotification
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("row raw failure"))

    const result = await service.processRun(NOW)

    expect(repository.insertInAppNotification).toHaveBeenCalledTimes(2)
    expect(result.channels.inApp).toEqual({ sent: 1, failed: 1, skipped: 0 })
  })

  it("reports final marker failure honestly without throwing after delivery", async () => {
    const { service, repository, mail, push } = makeHarness()
    repository.markProcessed.mockRejectedValueOnce(new Error("marker raw failure"))

    await expect(service.processRun(NOW)).resolves.toMatchObject({
      ok: false,
      processed: 0,
      persistenceFailed: true,
      channels: {
        email: { sent: 1, failed: 0, skipped: 0 },
        inApp: { sent: 1, failed: 0, skipped: 0 },
        push: { sent: 1, failed: 0, skipped: 0, pruned: 0 },
      },
    })
    expect(mail.send).toHaveBeenCalledTimes(1)
    expect(push.send).toHaveBeenCalledTimes(1)
  })
})
