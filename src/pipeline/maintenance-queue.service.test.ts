import { describe, expect, it, vi } from "vitest"
import type { JobsService } from "../jobs/jobs.service.js"
import type { DbService } from "../db/db.service.js"
import type { CronGateService } from "./cron-gate.service.js"
import {
  DATABASE_SIZE_WARNING_BYTES,
  MaintenanceQueueService,
  RETENTION_BATCH_SIZE,
} from "./maintenance-queue.service.js"
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
describe("retention step", () => {
  function runWith(passes: Record<string, number>[]) {
    const rest = [...passes]
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] }
      if (sql.includes("run_daily_maintenance")) return { rows: [{ summary: { legacy: true } }] }
      if (sql.includes("to_regprocedure")) return { rows: [{ present: true }] }
      return { rows: [{ pass: rest.shift() }] }
    })
    const db = { withTransaction: (fn: (client: unknown) => unknown) => fn({ query }) }
    const gate = { runGated: (_: unknown, fn: () => Promise<string>) => fn() }
    const worker = new MaintenanceQueueService(
      {} as JobsService,
      gate as unknown as CronGateService,
      db as unknown as DbService,
      { NODE_ENV: "production", CUTOVER_MAINTENANCE: "true" }
    )
    const warn = vi.spyOn(worker["logger"], "warn").mockImplementation(() => {})
    return { worker, warn, query }
  }
  it("warns when the database is still above 400 MB after pruning", async () => {
    const { worker, warn } = runWith([
      { event_ai_traces_pruned: 1, database_size_bytes: DATABASE_SIZE_WARNING_BYTES + 1 },
    ])
    await worker.handleJob({ task: "daily-maintenance" })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("400 MB"))
  })
  it("stays quiet at or below the threshold and repeats while any table fills its batch", async () => {
    const { worker, warn, query } = runWith([
      { event_ai_traces_pruned: RETENTION_BATCH_SIZE, database_size_bytes: 1 },
      { event_ai_traces_pruned: 3, database_size_bytes: DATABASE_SIZE_WARNING_BYTES },
    ])
    await worker.handleJob({ task: "daily-maintenance" })
    expect(warn).not.toHaveBeenCalled()
    expect(query.mock.calls.filter(([sql]) => sql.includes("run_retention($1)"))).toHaveLength(2)
  })
})
