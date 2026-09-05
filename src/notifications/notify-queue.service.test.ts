import { Logger } from "@nestjs/common"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { JobsService } from "../jobs/jobs.service.js"
import { NotifyQueueService } from "./notify-queue.service.js"
import type { NotificationQueueService } from "./notification-queue.service.js"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("NotifyQueueService", () => {
  it("registers the internal schedule with no retries and concurrency one", () => {
    const registerQueue = vi.fn()
    const queue = new NotifyQueueService(
      { registerQueue } as unknown as JobsService,
      { processRun: vi.fn() } as unknown as NotificationQueueService,
      { NODE_ENV: "production", CUTOVER_NOTIFY: "true" }
    )

    queue.onModuleInit()

    expect(registerQueue).toHaveBeenNthCalledWith(1, "notify.dlq", null)
    expect(registerQueue).toHaveBeenNthCalledWith(
      2,
      "notify",
      expect.any(Function),
      expect.objectContaining({ name: "notify", deadLetter: "notify.dlq", retryLimit: 0 }),
      {
        schedules: [
          {
            cron: "*/5 * * * *",
            data: { task: "process" },
            key: "process-notification-queue",
          },
        ],
        localConcurrency: 1,
      }
    )
  })

  it("installs nothing when the production flag is not exactly true", () => {
    const registerQueue = vi.fn()
    const registerScheduleRemoval = vi.fn()
    const queue = new NotifyQueueService(
      { registerQueue, registerScheduleRemoval } as unknown as JobsService,
      { processRun: vi.fn() } as unknown as NotificationQueueService,
      { NODE_ENV: "production" }
    )

    queue.onModuleInit()

    expect(registerQueue).not.toHaveBeenCalled()
    expect(registerScheduleRemoval).toHaveBeenCalledWith("notify", "process-notification-queue")
  })

  it("fails closed at runtime when production ownership is disabled", async () => {
    const processRun = vi.fn()
    const queue = new NotifyQueueService(
      { registerQueue: vi.fn(), registerScheduleRemoval: vi.fn() } as unknown as JobsService,
      { processRun } as unknown as NotificationQueueService,
      { NODE_ENV: "production" }
    )

    await expect(queue.handleJob({ task: "process" })).rejects.toThrow(/disabled/)
    expect(processRun).not.toHaveBeenCalled()
  })

  it("runs process jobs directly without CronGate and logs only counts", async () => {
    const rawId = "11111111-1111-4111-8111-111111111111"
    const processRun = vi.fn(async () => ({
      ok: true,
      lockAcquired: true,
      skipped: false,
      skipReason: null,
      processed: 1,
      refreshed: 0,
      persistenceFailed: false,
      channels: {
        email: { sent: 1, failed: 0, skipped: 0 },
        inApp: { sent: 1, failed: 0, skipped: 0 },
        push: { sent: 1, failed: 0, skipped: 0, pruned: 0, unmatchedRecipients: 0 },
      },
    }))
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
    const queue = new NotifyQueueService(
      { registerQueue: vi.fn() } as unknown as JobsService,
      { processRun } as unknown as NotificationQueueService,
      { NODE_ENV: "production", CUTOVER_NOTIFY: "true", SECRET: rawId }
    )

    await queue.handleJob({ task: "process" })

    expect(processRun).toHaveBeenCalledWith(expect.any(Date))
    expect(log.mock.calls.flat().join(" ")).not.toContain(rawId)
  })
})
