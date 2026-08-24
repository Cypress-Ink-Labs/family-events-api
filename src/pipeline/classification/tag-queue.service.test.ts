import { afterEach, describe, expect, it } from "vitest"

import type { EnrichmentRepository } from "../enrichment/enrichment.repository.js"
import type { CronGateService } from "../cron-gate.service.js"
import type { FamilySchedule } from "../families.js"
import type { JobsService, QueueSchedule } from "../../jobs/jobs.service.js"
import type { ClassificationRepository } from "./classification.repository.js"
import {
  TagQueueService,
  enrichmentDependenciesFromEnv,
  type TagJobData,
} from "./tag-queue.service.js"
import type { EventInputs, TagQueueRow } from "./process-tag-queue.js"

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
    options: { name?: string; deadLetter?: string; retryLimit?: number } = {},
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

class FakeClassificationRepository {
  claimable: TagQueueRow[] = []
  pendingAfter = 0
  completed: number[] = []

  async reapStuckTagQueueRows(): Promise<number> {
    return 0
  }
  async claimTagQueueBatch(): Promise<TagQueueRow[]> {
    return this.claimable.splice(0)
  }
  async fetchEventInputsBulk(): Promise<Map<string, EventInputs>> {
    return new Map()
  }
  async markTagQueueRowStarted(queueId: number): Promise<TagQueueRow> {
    return {
      id: queueId,
      event_id: "evt-1",
      source_run_id: null,
      trigger_type: "import",
      attempt_count: 1,
    }
  }
  async fetchEventInputs(): Promise<EventInputs | null> {
    return null
  }
  async completeTagQueueRow(rowId: number): Promise<void> {
    this.completed.push(rowId)
  }
  async countPendingTagQueueRows(): Promise<number> {
    return this.pendingAfter
  }
}

class FakeEnrichmentRepository {
  async listEventsNeedingEnrichment(): Promise<[]> {
    return []
  }
  async listImageEnrichmentInScope(): Promise<[]> {
    return []
  }
  async listPendingUnsplashTracking(): Promise<[]> {
    return []
  }
  async listEventsNeedingAttributionBackfill(): Promise<[]> {
    return []
  }
  async loadParentTipsFeatureConfig(): Promise<null> {
    return null
  }
}

function makeService() {
  const jobs = new FakeJobs()
  const gate = new FakeGate()
  const classification = new FakeClassificationRepository()
  const enrichment = new FakeEnrichmentRepository()
  const service = new TagQueueService(
    jobs as unknown as JobsService,
    gate as unknown as CronGateService,
    classification as unknown as ClassificationRepository,
    enrichment as unknown as EnrichmentRepository
  )
  return { service, jobs, gate, classification }
}

afterEach(() => {
  delete process.env.NODE_ENV
  delete process.env.CUTOVER_TAG
})

describe("TagQueueService registration", () => {
  it("installs nothing in production without CUTOVER_TAG", () => {
    process.env.NODE_ENV = "production"
    const { service, jobs } = makeService()

    service.onModuleInit()

    expect(jobs.registered).toEqual([])
  })

  it("registers the tag DLQ, worker, and both parity schedules when enabled", () => {
    process.env.NODE_ENV = "production"
    process.env.CUTOVER_TAG = "true"
    const { service, jobs } = makeService()

    service.onModuleInit()

    expect(jobs.registered.map((queue) => queue.name)).toEqual(["tag.dlq", "tag"])
    expect(jobs.registered[0]?.hasHandler).toBe(false)
    expect(jobs.registered[1]).toMatchObject({
      hasHandler: true,
      options: { deadLetter: "tag.dlq", retryLimit: 3 },
      batchSize: 2,
      schedules: [
        { cron: "*/5 * * * *", data: { task: "process-tag-queue" }, key: "process-tag-queue" },
        {
          cron: "*/15 * * * *",
          data: { task: "backfill-enrichment" },
          key: "backfill-enrichment",
        },
      ],
    })
  })
})

describe("TagQueueService task dispatch", () => {
  it("rejects unknown tasks", async () => {
    const { service } = makeService()
    await expect(service.handleJob({ task: "mystery" })).rejects.toThrow(/unknown tag task/)
    await expect(service.handleJob({} as TagJobData)).rejects.toThrow(/unknown tag task/)
  })

  it("runs the tag batch through the legacy cron gate", async () => {
    const { service, gate } = makeService()

    await service.handleJob({ task: "process-tag-queue" })

    expect(gate.runs).toEqual(["process-tag-queue"])
  })

  it("chains another singleton tag batch while immediately claimable work remains", async () => {
    const { service, jobs, classification } = makeService()
    classification.claimable = [
      {
        id: 1,
        event_id: "evt-1",
        source_run_id: null,
        trigger_type: "import",
        attempt_count: 0,
      },
    ]
    classification.pendingAfter = 1

    await service.handleJob({ task: "process-tag-queue" })

    expect(classification.completed).toEqual([1])
    expect(jobs.sent).toEqual([
      {
        name: "tag",
        data: { task: "drain-tag-queue" },
        options: { singletonKey: "drain-tag-queue" },
      },
    ])
  })

  it("runs enrichment through its legacy cron gate", async () => {
    const { service, gate } = makeService()

    await service.handleJob({ task: "backfill-enrichment" })

    expect(gate.runs).toEqual(["backfill-enrichment"])
  })
})

describe("enrichmentDependenciesFromEnv", () => {
  it("uses one Unsplash env value for search, tracking, and attribution backfill", () => {
    const dependencies = enrichmentDependenciesFromEnv({
      PEXELS_API_KEY: "pexels-key",
      PIXABAY_API_KEY: "pixabay-key",
      UNSPLASH_ACCESS_KEY: "unsplash-key",
    })

    expect(dependencies.providerKeys).toEqual({
      pexels: "pexels-key",
      pixabay: "pixabay-key",
      unsplash: "unsplash-key",
    })
    expect(dependencies.unsplashAccessKey).toBe(dependencies.providerKeys.unsplash)
  })
})
