import { describe, expect, it, vi } from "vitest"
import type { JobsService } from "../jobs/jobs.service.js"
import type { DbService } from "../db/db.service.js"
import type { CronGateService } from "./cron-gate.service.js"
import { MaintenanceQueueService } from "./maintenance-queue.service.js"
describe("dedicated daily maintenance registration", () => {
  it("registers one UTC parity schedule on its own serial queue", () => {
    const registerQueue = vi.fn()
    const worker = new MaintenanceQueueService(
      { registerQueue } as unknown as JobsService,
      {} as CronGateService,
      {} as DbService,
      { NODE_ENV: "production", CUTOVER_MAINTENANCE: "true" }
    )
    worker.onModuleInit()
    expect(registerQueue).toHaveBeenCalledTimes(2)
    expect(registerQueue).toHaveBeenNthCalledWith(1, "maintenance.dlq", null)
    expect(registerQueue.mock.calls[1]).toMatchObject([
      "maintenance",
      expect.any(Function),
      { name: "maintenance", deadLetter: "maintenance.dlq" },
      {
        schedules: [
          { cron: "15 3 * * *", data: { task: "daily-maintenance" }, key: "daily-maintenance" },
        ],
        localConcurrency: 1,
      },
    ])
  })
  it.each([undefined, "false", "TRUE", "1"])(
    "installs nothing in production for flag %s and removes the old API schedule",
    (flag) => {
      const jobs = { registerQueue: vi.fn(), registerScheduleRemoval: vi.fn() }
      new MaintenanceQueueService(
        jobs as unknown as JobsService,
        {} as CronGateService,
        {} as DbService,
        { NODE_ENV: "production", CUTOVER_MAINTENANCE: flag }
      ).onModuleInit()
      expect(jobs.registerQueue).not.toHaveBeenCalled()
      expect(jobs.registerScheduleRemoval).toHaveBeenCalledWith("maintenance", "daily-maintenance")
    }
  )
  it("rejects runtime-disabled and unsupported manual payloads before SQL", async () => {
    const runGated = vi.fn()
    const worker = new MaintenanceQueueService(
      {} as JobsService,
      { runGated } as unknown as CronGateService,
      {} as DbService,
      { NODE_ENV: "production" }
    )
    await expect(worker.handleJob({ task: "daily-maintenance" })).rejects.toThrow(/disabled/)
    expect(runGated).not.toHaveBeenCalled()
    const enabled = new MaintenanceQueueService(
      {} as JobsService,
      { runGated } as unknown as CronGateService,
      {} as DbService,
      { NODE_ENV: "production", CUTOVER_MAINTENANCE: "true" }
    )
    await expect(enabled.handleJob({ task: "other" })).rejects.toThrow(/unknown/)
  })
})
