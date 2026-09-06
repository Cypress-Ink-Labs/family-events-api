import { Logger } from "@nestjs/common"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { JobsService } from "../jobs/jobs.service.js"
import type { CronGateService } from "../pipeline/cron-gate.service.js"
import { ReminderQueueService } from "./reminder-queue.service.js"
import type { ReminderRunResult, ReminderService } from "./reminder.service.js"
import { SCHEDULED_NOTIFICATION_EXPIRE_SECONDS } from "./scheduled-notification.js"

function makeQueueService() {
  const summary: ReminderRunResult = {
    total: 3,
    channels: {
      email: { sent: 1, failed: 1, skipped: 1 },
      inApp: { sent: 2, failed: 1, skipped: 0 },
      push: {
        sentSubscriptions: 2,
        failedSubscriptions: 0,
        skippedSubscriptions: 1,
        prunedSubscriptions: 0,
        unmatchedRecipients: 0,
        skippedRecipients: 0,
        failedDispatches: 0,
        failedBatches: 0,
        failedBatchRecipients: 0,
      },
    },
  }
  const jobs = { registerQueue: vi.fn() }
  const gate = {
    runGated: vi.fn(async (_schedule, work: () => Promise<string>) => work()),
  }
  const reminders = { processRun: vi.fn(async () => summary) }
  return {
    queue: new ReminderQueueService(
      jobs as unknown as JobsService,
      gate as unknown as CronGateService,
      reminders as unknown as ReminderService
    ),
    jobs,
    gate,
    reminders,
    summary,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("ReminderQueueService dispatch", () => {
  it("registers a no-retry queue with the scheduled notification expiration budget", () => {
    vi.stubEnv("CUTOVER_REMINDERS", "true")
    const { queue, jobs } = makeQueueService()

    queue.onModuleInit()

    const registration = jobs.registerQueue.mock.calls.find((call) => call[1] !== null)
    expect(registration?.[2]).toMatchObject({
      expireInSeconds: SCHEDULED_NOTIFICATION_EXPIRE_SECONDS,
      retryLimit: 0,
    })
  })

  it("persists and logs all channel counts through the legacy ownership gate", async () => {
    const { queue, gate, reminders, summary } = makeQueueService()
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => {})

    await queue.handleJob({ task: "send" })

    expect(gate.runGated).toHaveBeenCalledTimes(1)
    expect(reminders.processRun).toHaveBeenCalledWith(expect.any(Date), undefined)
    expect(await gate.runGated.mock.results[0]?.value).toBe(JSON.stringify(summary))
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reminder run complete: total=3"))
    for (const [channel, counts] of Object.entries(summary.channels)) {
      for (const [name, count] of Object.entries(counts)) {
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`${channel}_${name}=${count}`))
      }
    }
  })

  it("forwards cancellation from the registered worker to the reminder run", async () => {
    vi.stubEnv("CUTOVER_REMINDERS", "true")
    const { queue, jobs, reminders } = makeQueueService()
    const controller = new AbortController()
    queue.onModuleInit()
    const registration = jobs.registerQueue.mock.calls.find((call) => call[1] !== null)!

    await registration[1]({ task: "send" }, "job-1", controller.signal)

    expect(reminders.processRun).toHaveBeenCalledWith(expect.any(Date), controller.signal)
  })

  it("rejects an aborted job before acquiring the gate", async () => {
    const { queue, gate, reminders } = makeQueueService()
    const controller = new AbortController()
    controller.abort(new Error("job expired"))

    await expect(queue.handleJob({ task: "send" }, controller.signal)).rejects.toThrow(
      "job expired"
    )

    expect(gate.runGated).not.toHaveBeenCalled()
    expect(reminders.processRun).not.toHaveBeenCalled()
  })

  it("checks cancellation again when the gate admits the job", async () => {
    const { queue, gate, reminders } = makeQueueService()
    const controller = new AbortController()
    gate.runGated.mockImplementationOnce(async (_schedule, work) => {
      controller.abort(new Error("job expired while waiting"))
      return work()
    })

    await expect(queue.handleJob({ task: "send" }, controller.signal)).rejects.toThrow(
      "job expired while waiting"
    )

    expect(gate.runGated).toHaveBeenCalledTimes(1)
    expect(reminders.processRun).not.toHaveBeenCalled()
  })

  it("rejects unknown tasks without delivery or acquiring the gate", async () => {
    const { queue, gate, reminders } = makeQueueService()

    await expect(queue.handleJob({ task: "unknown" })).rejects.toThrow("unknown reminders task")

    expect(gate.runGated).not.toHaveBeenCalled()
    expect(reminders.processRun).not.toHaveBeenCalled()
  })
})
