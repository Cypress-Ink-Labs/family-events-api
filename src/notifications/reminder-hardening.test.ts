import { ConfigService } from "@nestjs/config"
import { describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import type { MailService, SendMailInput, SendMailResult } from "./mail.service.js"
import type { PushSendContext, PushService, SendPushInput, SendPushResult } from "./push.service.js"
import type {
  ReminderInAppNotificationRow,
  ReminderRepository,
  ReminderTarget,
} from "./reminder.repository.js"
import { ReminderService } from "./reminder.service.js"

const NOW = new Date("2026-08-16T16:00:00Z")
const target: ReminderTarget = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "reader@example.com",
  displayName: "Reader",
  eventId: "22222222-2222-4222-8222-222222222222",
  title: "Storytime",
  startDatetime: "2026-08-16T15:30:00.000Z",
  venueName: "Library",
  address: null,
  reminderEmail: true,
  reminderPush: true,
}

function targets(count: number): ReminderTarget[] {
  return Array.from({ length: count }, (_, index) => ({ ...target, userId: `user-${index}` }))
}

function makeService() {
  const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {})
  const repository = {
    findReminderTargets: vi.fn(async () => [] as ReminderTarget[]),
    insertInAppNotifications: vi.fn(async (rows: ReminderInAppNotificationRow[]) => rows.length),
    insertInAppNotification: vi.fn(async (_row: ReminderInAppNotificationRow) => 1),
  }
  const mail = {
    send: vi.fn(async (_input: SendMailInput): Promise<SendMailResult> => ({ sent: true })),
  }
  const push = {
    createSendContext: vi.fn((): PushSendContext => ({ subscriptions: new Map() })),
    send: vi.fn(
      async (
        input: SendPushInput,
        _context?: PushSendContext,
        _signal?: AbortSignal
      ): Promise<SendPushResult> => ({
        requestedRecipients: input.userIds.length,
        matchedRecipients: input.userIds.length,
        unmatchedRecipients: 0,
        failedBatches: 0,
        failedBatchRecipients: 0,
        sent: input.userIds.length,
        failed: 0,
        skipped: 0,
        pruned: 0,
      })
    ),
  }
  const config = new ConfigService({ APP_URL: "https://events.example.com" }) as ConfigService<
    Env,
    true
  >
  return {
    service: new ReminderService(
      repository as unknown as ReminderRepository,
      mail as unknown as MailService,
      config,
      push as unknown as PushService,
      { sleep }
    ),
    repository,
    mail,
    push,
    sleep,
  }
}

describe("reminder hardening", () => {
  it.each([0, 1, 10, 11, 21])(
    "paces %i targets in deterministic batches of ten, with no final delay",
    async (count) => {
      const { service, repository, mail, push, sleep } = makeService()
      const recipients = targets(count)
      repository.findReminderTargets.mockResolvedValueOnce(recipients)
      const completedAtDelay: Array<{ email: number; push: number; inApp: number }> = []
      sleep.mockImplementation(async () => {
        completedAtDelay.push({
          email: mail.send.mock.calls.length,
          push: push.send.mock.calls.reduce((sum, [input]) => sum + input.userIds.length, 0),
          inApp: repository.insertInAppNotifications.mock.calls.reduce(
            (sum, [rows]) => sum + rows.length,
            0
          ),
        })
      })

      const result = await service.processRun(NOW)

      expect(result.total).toBe(count)
      expect(result.channels.email.sent).toBe(count)
      expect(result.channels.inApp.sent).toBe(count)
      expect(result.channels.push.sentSubscriptions).toBe(count)
      expect(completedAtDelay).toEqual(
        Array.from({ length: Math.max(0, Math.ceil(count / 10) - 1) }, (_, index) => ({
          email: (index + 1) * 10,
          push: (index + 1) * 10,
          inApp: (index + 1) * 10,
        }))
      )
      expect(sleep.mock.calls.every(([ms]) => ms === 300)).toBe(true)
      expect(repository.insertInAppNotifications.mock.calls.map(([rows]) => rows.length)).toEqual(
        Array.from({ length: Math.ceil(count / 10) }, (_, index) =>
          Math.min(10, count - index * 10)
        )
      )
      expect(
        repository.insertInAppNotifications.mock.calls.flatMap(([rows]) =>
          rows.map((row) => row.userId)
        )
      ).toEqual(recipients.map((row) => row.userId))
      expect(push.createSendContext).toHaveBeenCalledTimes(1)
      for (const [, context] of push.send.mock.calls) {
        expect(context).toBe(push.createSendContext.mock.results[0]!.value)
      }
    }
  )

  it("paces across the morning-of/day-before boundary after deduplicating targets", async () => {
    const { service, repository, sleep } = makeService()
    const morning = targets(7)
    const tomorrow = targets(5)
    repository.findReminderTargets
      .mockResolvedValueOnce([...morning, morning[0]!])
      .mockResolvedValueOnce([...tomorrow, tomorrow[0]!])

    const result = await service.processRun(NOW)

    expect(result.total).toBe(12)
    expect(repository.insertInAppNotifications.mock.calls.map(([rows]) => rows.length)).toEqual([
      10, 2,
    ])
    expect(sleep).toHaveBeenCalledTimes(1)
    const rows = repository.insertInAppNotifications.mock.calls.flatMap(([batch]) => batch)
    expect(new Set(rows.map((row) => row.id)).size).toBe(12)
  })

  it("keeps stable IDs across replay and reports actual upsert counts including zero", async () => {
    const { service, repository, push } = makeService()
    repository.findReminderTargets
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([])
    repository.insertInAppNotifications.mockResolvedValueOnce(1).mockResolvedValueOnce(0)

    const first = await service.processRun(NOW)
    const replay = await service.processRun(NOW)

    expect(first.channels.inApp).toEqual({ sent: 1, failed: 0, skipped: 0 })
    expect(replay.channels.inApp).toEqual({ sent: 0, failed: 0, skipped: 0 })
    expect(repository.insertInAppNotifications.mock.calls[1]![0]).toEqual(
      repository.insertInAppNotifications.mock.calls[0]![0]
    )
    expect(repository.insertInAppNotifications.mock.calls[0]![0][0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(push.createSendContext).toHaveBeenCalledTimes(2)
    expect(push.createSendContext.mock.results[0]!.value).not.toBe(
      push.createSendContext.mock.results[1]!.value
    )
  })

  it("counts zero fallback upserts without inventing sent or failed notifications", async () => {
    const { service, repository } = makeService()
    repository.findReminderTargets.mockResolvedValueOnce(targets(2))
    repository.insertInAppNotifications.mockRejectedValueOnce(new Error("lost bulk response"))
    repository.insertInAppNotification.mockResolvedValueOnce(0).mockResolvedValueOnce(1)

    const result = await service.processRun(NOW)

    expect(result.channels.inApp).toEqual({ sent: 1, failed: 0, skipped: 0 })
    expect(repository.insertInAppNotification.mock.calls.map(([row]) => row)).toEqual(
      repository.insertInAppNotifications.mock.calls[0]![0]
    )
  })

  it("rejects an already cancelled run before querying", async () => {
    const { service, repository } = makeService()
    await expect(
      service.processRun(NOW, AbortSignal.abort(new Error("cancelled")))
    ).rejects.toThrow("cancelled")
    expect(repository.findReminderTargets).not.toHaveBeenCalled()
  })

  it("stops all channel side effects when cancellation arrives during target lookup", async () => {
    const { service, repository, mail, push } = makeService()
    const controller = new AbortController()
    repository.findReminderTargets.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"))
      return [target]
    })

    await expect(service.processRun(NOW, controller.signal)).rejects.toThrow("cancelled")
    expect(mail.send).not.toHaveBeenCalled()
    expect(push.send).not.toHaveBeenCalled()
    expect(repository.insertInAppNotifications).not.toHaveBeenCalled()
  })

  it("propagates email cancellation and stops later channels", async () => {
    const { service, repository, mail, push } = makeService()
    const controller = new AbortController()
    repository.findReminderTargets.mockResolvedValueOnce(targets(2))
    mail.send.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"))
      throw controller.signal.reason
    })

    await expect(service.processRun(NOW, controller.signal)).rejects.toThrow("cancelled")
    expect(mail.send).toHaveBeenCalledTimes(1)
    expect(mail.send.mock.calls[0]![0].signal).toBe(controller.signal)
    expect(push.send).not.toHaveBeenCalled()
    expect(repository.insertInAppNotifications).not.toHaveBeenCalled()
  })

  it("checks cancellation between fallback writes", async () => {
    const { service, repository } = makeService()
    const controller = new AbortController()
    repository.findReminderTargets.mockResolvedValueOnce(targets(2))
    repository.insertInAppNotifications.mockRejectedValueOnce(new Error("bulk failure"))
    repository.insertInAppNotification.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"))
      return 1
    })

    await expect(service.processRun(NOW, controller.signal)).rejects.toThrow("cancelled")
    expect(repository.insertInAppNotification).toHaveBeenCalledTimes(1)
  })

  it("passes cancellation with the run push context and rethrows a cancelled push", async () => {
    const { service, repository, push } = makeService()
    const controller = new AbortController()
    repository.findReminderTargets.mockResolvedValueOnce([target])
    push.send.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"))
      throw controller.signal.reason
    })

    await expect(service.processRun(NOW, controller.signal)).rejects.toThrow("cancelled")
    expect(push.send.mock.calls[0]![1]).toBe(push.createSendContext.mock.results[0]!.value)
    expect(push.send.mock.calls[0]![2]).toBe(controller.signal)
  })

  it("stops the next batch when cancelled during the abortable delay", async () => {
    const { service, repository, mail, sleep } = makeService()
    const controller = new AbortController()
    repository.findReminderTargets.mockResolvedValueOnce(targets(11))
    sleep.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"))
    })

    await expect(service.processRun(NOW, controller.signal)).rejects.toThrow("cancelled")
    expect(sleep).toHaveBeenCalledWith(300, controller.signal)
    expect(mail.send).toHaveBeenCalledTimes(10)
  })
})
