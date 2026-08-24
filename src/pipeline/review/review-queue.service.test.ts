import { afterEach, describe, expect, it } from "vitest"

import type { JobsService, QueueSchedule } from "../../jobs/jobs.service.js"
import type { CronGateService } from "../cron-gate.service.js"
import type { FamilySchedule } from "../families.js"
import type { ReviewRepository } from "./review.repository.js"
import { ReviewQueueService } from "./review-queue.service.js"

interface RegisteredQueue {
  name: string
  hasHandler: boolean
  options: { deadLetter?: string; retryLimit?: number }
  schedules: QueueSchedule[]
  localConcurrency: number
}

class FakeJobs {
  registered: RegisteredQueue[] = []

  registerQueue(
    name: string,
    handler: unknown,
    options: { name?: string; deadLetter?: string; retryLimit?: number } = {},
    config: { schedules?: QueueSchedule[]; localConcurrency?: number } = {}
  ): void {
    this.registered.push({
      name,
      hasHandler: handler !== null,
      options,
      schedules: config.schedules ?? [],
      localConcurrency: config.localConcurrency ?? 1,
    })
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

class FakeReviewRepository {
  featureConfigLoads = 0
  reaps = 0
  claims = 0

  async loadEventReviewFeatureConfig() {
    this.featureConfigLoads += 1
    return { model: "gpt-4.1-nano", enabled: false, provider: "openai" }
  }
  async reapStuckReviewQueueRows(): Promise<number> {
    this.reaps += 1
    return 0
  }
  async claimReviewQueueBatch(): Promise<[]> {
    this.claims += 1
    return []
  }
}

function makeService() {
  const jobs = new FakeJobs()
  const gate = new FakeGate()
  const repository = new FakeReviewRepository()
  const service = new ReviewQueueService(
    jobs as unknown as JobsService,
    gate as unknown as CronGateService,
    repository as unknown as ReviewRepository
  )
  return { service, jobs, gate, repository }
}

afterEach(() => {
  delete process.env.NODE_ENV
  delete process.env.CUTOVER_REVIEW
})

describe("ReviewQueueService registration", () => {
  it("installs nothing in production without CUTOVER_REVIEW", () => {
    process.env.NODE_ENV = "production"
    const { service, jobs } = makeService()

    service.onModuleInit()

    expect(jobs.registered).toEqual([])
  })

  it("registers the review DLQ, worker, and parity schedule when enabled", () => {
    process.env.NODE_ENV = "production"
    process.env.CUTOVER_REVIEW = "true"
    const { service, jobs } = makeService()

    service.onModuleInit()

    expect(jobs.registered.map((queue) => queue.name)).toEqual(["review.dlq", "review"])
    expect(jobs.registered[0]?.hasHandler).toBe(false)
    expect(jobs.registered[1]).toMatchObject({
      hasHandler: true,
      options: { deadLetter: "review.dlq", retryLimit: 3 },
      localConcurrency: 2,
      schedules: [
        {
          cron: "*/5 * * * *",
          data: { task: "process-review-queue" },
          key: "process-review-queue",
        },
      ],
    })
  })
})

describe("ReviewQueueService task dispatch", () => {
  it("rejects unknown tasks", async () => {
    const { service } = makeService()
    await expect(service.handleJob({ task: "mystery" })).rejects.toThrow(/unknown review task/)
    await expect(service.handleJob({})).rejects.toThrow(/unknown review task/)
  })

  it("loads DB-backed routing and runs the batch through the legacy cron gate", async () => {
    const { service, gate, repository } = makeService()

    await service.handleJob({ task: "process-review-queue" })

    expect(gate.runs).toEqual(["process-review-queue"])
    expect(repository.featureConfigLoads).toBe(1)
    expect(repository.reaps).toBe(1)
    expect(repository.claims).toBe(1)
  })

  it("does not touch the review queue when the legacy kill switch is off", async () => {
    const { service, gate, repository } = makeService()
    gate.enabled = false

    await service.handleJob({ task: "process-review-queue" })

    expect(repository.featureConfigLoads).toBe(0)
    expect(repository.reaps).toBe(0)
    expect(repository.claims).toBe(0)
  })
})
