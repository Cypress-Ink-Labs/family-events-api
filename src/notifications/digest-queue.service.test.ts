import { Logger } from "@nestjs/common"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { JobsService } from "../jobs/jobs.service.js"
import type { CronGateService } from "../pipeline/cron-gate.service.js"
import { DigestQueueService } from "./digest-queue.service.js"
import type { DigestService } from "./digest.service.js"
import { SCHEDULED_NOTIFICATION_EXPIRE_SECONDS } from "./scheduled-notification.js"

const channelSummary = {
  emailed: 1,
  skipped: 2,
  failed: 3,
  telegramSent: 4,
  telegramSkipped: 5,
  telegramFailed: 6,
}

function makeQueueService() {
  const jobs = { registerQueue: vi.fn() }
  const gate = {
    runGated: vi.fn(async (_schedule, work: () => Promise<string>) => work()),
  }
  const digest = {
    processRun: vi.fn(async () => channelSummary),
  }
  return {
    queue: new DigestQueueService(
      jobs as unknown as JobsService,
      gate as unknown as CronGateService,
      digest as unknown as DigestService
    ),
    gate,
    digest,
    jobs,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("DigestQueueService dispatch", () => {
  it("registers a no-retry queue with the scheduled notification expiration budget", () => {
    vi.stubEnv("CUTOVER_DIGEST", "true")
    const { queue, jobs } = makeQueueService()

    queue.onModuleInit()

    const registration = jobs.registerQueue.mock.calls.find((call) => call[1] !== null)
    expect(registration?.[2]).toMatchObject({
      expireInSeconds: SCHEDULED_NOTIFICATION_EXPIRE_SECONDS,
      retryLimit: 0,
    })
  })

  it("routes scheduled sends through the atomic legacy ownership gate", async () => {
    const { queue, gate, digest } = makeQueueService()

    await queue.handleJob({ task: "send" })

    expect(gate.runGated).toHaveBeenCalledTimes(1)
    expect(digest.processRun).toHaveBeenCalledWith(expect.any(Date), undefined, undefined)
  })

  it("allows a scoped manual test while legacy still owns the schedule", async () => {
    const { queue, gate, digest } = makeQueueService()

    await queue.handleJob({ task: "test", testEmail: "reader@example.com" })

    expect(gate.runGated).not.toHaveBeenCalled()
    expect(digest.processRun).toHaveBeenCalledWith(
      expect.any(Date),
      "reader@example.com",
      undefined
    )
  })

  it("requires an email for manual tests and rejects testEmail on scheduled jobs", async () => {
    const { queue } = makeQueueService()
    await expect(queue.handleJob({ task: "test" })).rejects.toThrow(/requires testEmail/)
    await expect(
      queue.handleJob({ task: "send", testEmail: "reader@example.com" })
    ).rejects.toThrow(/does not accept testEmail/)
  })

  it.each(["send", "test"])(
    "logs explicit per-channel counts for %s without recipient data",
    async (task) => {
      const { queue, gate } = makeQueueService()
      const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)

      await queue.handleJob(task === "test" ? { task, testEmail: "private@example.com" } : { task })

      const output = JSON.stringify(log.mock.calls)
      for (const field of [
        "emailed",
        "skipped",
        "failed",
        "telegramSent",
        "telegramSkipped",
        "telegramFailed",
      ] as const) {
        expect(output).toContain(`${field}=${channelSummary[field]}`)
      }
      expect(output).not.toContain("private@example.com")
      if (task === "send") {
        expect(JSON.parse(await gate.runGated.mock.results[0]!.value)).toEqual(channelSummary)
      }
    }
  )

  it.each(["", "   "])(
    "rejects an empty test destination %j before dispatch",
    async (testEmail) => {
      const { queue, digest, gate } = makeQueueService()

      await expect(queue.handleJob({ task: "test", testEmail })).rejects.toThrow(
        /requires testEmail/
      )
      expect(digest.processRun).not.toHaveBeenCalled()
      expect(gate.runGated).not.toHaveBeenCalled()
    }
  )
})

describe("digest queue cancellation", () => {
  it("passes the third JobsService callback argument through the scheduled gate", async () => {
    vi.stubEnv("CUTOVER_DIGEST", "true")
    const { queue, jobs, digest } = makeQueueService()
    const controller = new AbortController()
    queue.onModuleInit()
    const handler = jobs.registerQueue.mock.calls.find((call) => typeof call[1] === "function")![1]
    await handler({ task: "send" }, "job-id", controller.signal)
    expect(digest.processRun).toHaveBeenCalledWith(expect.any(Date), undefined, controller.signal)
  })

  it("passes the signal to scoped test runs", async () => {
    const { queue, digest } = makeQueueService()
    const controller = new AbortController()
    await queue.handleJob({ task: "test", testEmail: "test@example.com" }, controller.signal)
    expect(digest.processRun).toHaveBeenCalledWith(
      expect.any(Date),
      "test@example.com",
      controller.signal
    )
  })

  it("rejects cancelled work before acquiring a gate or processing a run", async () => {
    const { queue, gate, digest } = makeQueueService()
    await expect(queue.handleJob({ task: "send" }, AbortSignal.abort())).rejects.toThrow(/abort/i)
    expect(gate.runGated).not.toHaveBeenCalled()
    expect(digest.processRun).not.toHaveBeenCalled()
  })

  it("does not log completion when processing is aborted", async () => {
    const { queue, digest } = makeQueueService()
    const controller = new AbortController()
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => {})
    digest.processRun.mockImplementation(async () => {
      controller.abort()
      throw controller.signal.reason
    })
    await expect(queue.handleJob({ task: "send" }, controller.signal)).rejects.toThrow(/abort/i)
    expect(log).not.toHaveBeenCalled()
  })
})
