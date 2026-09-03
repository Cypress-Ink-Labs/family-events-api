import { ConfigService } from "@nestjs/config"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import type { MailService, SendMailResult } from "./mail.service.js"
import type { ReminderRepository, ReminderTarget } from "./reminder.repository.js"
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
}

function makeService() {
  const repository = {
    findReminderTargets: vi.fn(async () => [] as ReminderTarget[]),
  }
  const mail = {
    send: vi.fn(async (): Promise<SendMailResult> => ({ sent: true, status: 200 })),
  }
  const config = {
    get: (key: keyof Env) => (key === "APP_URL" ? "https://events.example.com/" : undefined),
  } as ConfigService<Env, true>
  return {
    service: new ReminderService(
      repository as unknown as ReminderRepository,
      mail as unknown as MailService,
      config
    ),
    repository,
    mail,
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
      emailed: 1,
      skipped: 0,
      failed: 0,
    })
    expect(mail.send).toHaveBeenCalledTimes(1)
  })

  it("skips explicit opt-outs while missing preferences stay opted in", async () => {
    const { service, repository, mail } = makeService()
    repository.findReminderTargets.mockResolvedValueOnce([
      { ...target, reminderEmail: false },
      { ...target, eventId: "33333333-3333-4333-8333-333333333333", reminderEmail: null },
    ])

    await expect(service.processRun(new Date("2026-08-16T16:00:00Z"))).resolves.toEqual({
      emailed: 1,
      skipped: 1,
      failed: 0,
    })
    expect(mail.send).toHaveBeenCalledTimes(1)
  })

  it("sends the hosted template with the seven legacy variables", async () => {
    const { service, repository, mail } = makeService()
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
  })

  it("reports a MailService soft-failure and does not throw", async () => {
    const { service, repository, mail } = makeService()
    repository.findReminderTargets.mockResolvedValueOnce([target])
    mail.send.mockResolvedValueOnce({ sent: false, dev: true })

    await expect(service.processRun(new Date("2026-08-16T16:00:00Z"))).resolves.toEqual({
      emailed: 0,
      skipped: 0,
      failed: 1,
    })
  })
})
