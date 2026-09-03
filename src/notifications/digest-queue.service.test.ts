import { describe, expect, it, vi } from "vitest"

import type { JobsService } from "../jobs/jobs.service.js"
import type { CronGateService } from "../pipeline/cron-gate.service.js"
import { DigestQueueService } from "./digest-queue.service.js"
import type { DigestService } from "./digest.service.js"

function makeQueueService() {
  const jobs = { registerQueue: vi.fn() }
  const gate = {
    runGated: vi.fn(async (_schedule, work: () => Promise<string>) => work()),
  }
  const digest = {
    processRun: vi.fn(async () => ({ emailed: 1, skipped: 0, failed: 0 })),
  }
  return {
    queue: new DigestQueueService(
      jobs as unknown as JobsService,
      gate as unknown as CronGateService,
      digest as unknown as DigestService
    ),
    gate,
    digest,
  }
}

describe("DigestQueueService dispatch", () => {
  it("routes scheduled sends through the atomic legacy ownership gate", async () => {
    const { queue, gate, digest } = makeQueueService()

    await queue.handleJob({ task: "send" })

    expect(gate.runGated).toHaveBeenCalledTimes(1)
    expect(digest.processRun).toHaveBeenCalledWith(expect.any(Date))
  })

  it("allows a scoped manual test while legacy still owns the schedule", async () => {
    const { queue, gate, digest } = makeQueueService()

    await queue.handleJob({ task: "test", testEmail: "reader@example.com" })

    expect(gate.runGated).not.toHaveBeenCalled()
    expect(digest.processRun).toHaveBeenCalledWith(expect.any(Date), "reader@example.com")
  })

  it("requires an email for manual tests and rejects testEmail on scheduled jobs", async () => {
    const { queue } = makeQueueService()
    await expect(queue.handleJob({ task: "test" })).rejects.toThrow(/requires testEmail/)
    await expect(
      queue.handleJob({ task: "send", testEmail: "reader@example.com" })
    ).rejects.toThrow(/does not accept testEmail/)
  })
})
