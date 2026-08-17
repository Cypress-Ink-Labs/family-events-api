import { afterEach, describe, expect, it } from "vitest"

import { ScrapeQueueService } from "./scrape-queue.service.js"
import type { IngestionRepository } from "./ingestion.repository.js"
import type { JobsService, QueueSchedule } from "../../jobs/jobs.service.js"
import type { CronGateService } from "../cron-gate.service.js"
import type { FailurePingService } from "../failure-ping.service.js"
import type { FamilySchedule } from "../families.js"
import type { SourceQueueRow } from "./source-queue.worker.js"

// U28 scrape family registration + task dispatch. The CUTOVER_SCRAPE
// creation-time gate is the structural guard against dual-write: when the
// flag is off the queue is never registered, so these tests pin both sides.

interface RegisteredQueue {
  name: string
  hasHandler: boolean
  options: { deadLetter?: string; retryLimit?: number }
  schedules: QueueSchedule[]
  batchSize: number
}

class FakeJobs {
  registered: RegisteredQueue[] = []
  sent: Array<{ name: string; data: object; options?: object }> = []

  registerQueue(
    name: string,
    handler: unknown,
    options: { name?: string; deadLetter?: string } = {},
    config: { schedules?: QueueSchedule[]; batchSize?: number } = {}
  ): void {
    this.registered.push({
      name,
      hasHandler: handler !== null,
      options,
      schedules: config.schedules ?? [],
      batchSize: config.batchSize ?? 1,
    })
  }

  async send(name: string, data: object, options?: object): Promise<string | null> {
    this.sent.push({ name, data, options })
    return "job-1"
  }
}

class FakeGate {
  enabled = true
  runs: string[] = []

  async runGated(schedule: FamilySchedule, fn: () => Promise<string | void>): Promise<void> {
    if (!this.enabled) return
    this.runs.push(schedule.key)
    await fn()
  }
}

class FakeRepository {
  dueRuns = 0
  cleanupRuns = 0
  claimable: SourceQueueRow[] = []
  claimableAfterDrain = false
  skips: Array<{ queueId: number; reason: string }> = []

  async runDueSourceScrapes(): Promise<void> {
    this.dueRuns += 1
  }
  async runCleanupStaleRuns(): Promise<void> {
    this.cleanupRuns += 1
  }
  async reapStuckSourceScrapeQueueRows(): Promise<number> {
    return 0
  }
  async claimSourceScrapeQueueBatch(limit: number): Promise<SourceQueueRow[]> {
    return this.claimable.splice(0, limit)
  }
  async releaseUnstartedSourceScrapeQueueRows(): Promise<number> {
    return 0
  }
  async markSourceScrapeQueueSkipped(queueId: number, reason: string): Promise<void> {
    this.skips.push({ queueId, reason })
  }
  async hasClaimableSourceScrapeRows(): Promise<boolean> {
    return this.claimableAfterDrain
  }
  // The drain tests use queue rows whose source is gone, so processing stops
  // at the skip path and none of the extraction/import surface is touched.
  async getEventSource(): Promise<null> {
    return null
  }
}

function makeService(overrides: { jobs?: FakeJobs; gate?: FakeGate; repo?: FakeRepository } = {}) {
  const jobs = overrides.jobs ?? new FakeJobs()
  const gate = overrides.gate ?? new FakeGate()
  const repo = overrides.repo ?? new FakeRepository()
  const service = new ScrapeQueueService(
    jobs as unknown as JobsService,
    gate as unknown as CronGateService,
    repo as unknown as IngestionRepository,
    { send: async () => "sent" } as unknown as FailurePingService
  )
  return { service, jobs, gate, repo }
}

afterEach(() => {
  delete process.env.CUTOVER_SCRAPE
})

describe("ScrapeQueueService registration", () => {
  it("does not install the queue when the cutover flag is off", () => {
    process.env.CUTOVER_SCRAPE = "false"
    const { service, jobs } = makeService()

    service.onModuleInit()

    expect(jobs.registered).toEqual([])
  })

  it("registers dlq + queue with U12-parity schedules when enabled", () => {
    process.env.CUTOVER_SCRAPE = "true"
    const { service, jobs } = makeService()

    service.onModuleInit()

    expect(jobs.registered.map((queue) => queue.name)).toEqual(["scrape.dlq", "scrape"])
    const dlq = jobs.registered[0]
    expect(dlq?.hasHandler).toBe(false)

    const scrape = jobs.registered[1]
    expect(scrape?.hasHandler).toBe(true)
    expect(scrape?.options.deadLetter).toBe("scrape.dlq")
    expect(scrape?.options.retryLimit).toBe(3)
    expect(scrape?.batchSize).toBe(2)
    expect(scrape?.schedules).toEqual([
      { cron: "0 * * * *", data: { task: "scrape-due-sources" }, key: "scrape-due-sources" },
      { cron: "*/30 * * * *", data: { task: "cleanup-stale-runs" }, key: "cleanup-stale-runs" },
    ])
  })
})

describe("ScrapeQueueService task dispatch", () => {
  it("rejects unknown tasks so pg-boss retry/dead-letter applies", async () => {
    const { service } = makeService()
    await expect(service.handleJob({ task: "mystery" })).rejects.toThrow(/unknown scrape task/)
    await expect(service.handleJob({})).rejects.toThrow(/unknown scrape task/)
  })

  it("scrape-due-sources runs the gated RPC and kicks a drain job", async () => {
    const { service, jobs, gate, repo } = makeService()

    await service.handleJob({ task: "scrape-due-sources" })

    expect(gate.runs).toEqual(["scrape-due-sources"])
    expect(repo.dueRuns).toBe(1)
    expect(jobs.sent).toEqual([
      {
        name: "scrape",
        data: { task: "drain-source-queue" },
        options: { singletonKey: "drain-source-queue" },
      },
    ])
  })

  it("scrape-due-sources does nothing when the kill switch is off", async () => {
    const gate = new FakeGate()
    gate.enabled = false
    const { service, jobs, repo } = makeService({ gate })

    await service.handleJob({ task: "scrape-due-sources" })

    expect(repo.dueRuns).toBe(0)
    expect(jobs.sent).toEqual([])
  })

  it("cleanup-stale-runs runs the gated cleanup RPC", async () => {
    const { service, gate, repo } = makeService()

    await service.handleJob({ task: "cleanup-stale-runs" })

    expect(gate.runs).toEqual(["cleanup-stale-runs"])
    expect(repo.cleanupRuns).toBe(1)
  })

  it("drain stops without chaining when the queue is empty", async () => {
    const { service, jobs } = makeService()

    await service.handleJob({ task: "drain-source-queue" })

    expect(jobs.sent).toEqual([])
  })

  it("drain processes a row and chains while claimable work remains", async () => {
    const repo = new FakeRepository()
    repo.claimable = [{ id: 7, source_id: "src-1", source_run_id: null, attempt_count: 0 }]
    repo.claimableAfterDrain = true
    const { service, jobs } = makeService({ repo })

    await service.handleJob({ task: "drain-source-queue" })

    expect(repo.skips).toEqual([{ queueId: 7, reason: "source deleted before processing" }])
    expect(jobs.sent).toEqual([
      {
        name: "scrape",
        data: { task: "drain-source-queue" },
        options: { singletonKey: "drain-source-queue" },
      },
    ])
  })
})
