import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { afterEach, describe, expect, it } from "vitest"

import { AppModule } from "../src/app.module.js"
import { JobsService, type QueueSchedule } from "../src/jobs/jobs.service.js"

interface RegisteredQueue {
  name: string
  schedules: QueueSchedule[]
}

class FakeJobs {
  registered: RegisteredQueue[] = []

  registerQueue(
    name: string,
    _handler: unknown,
    _options: object = {},
    config: { schedules?: QueueSchedule[] } = {}
  ): void {
    this.registered.push({ name, schedules: config.schedules ?? [] })
  }

  async send(): Promise<string | null> {
    return "job-1"
  }
}

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  CUTOVER_SCRAPE: process.env.CUTOVER_SCRAPE,
  CUTOVER_TAG: process.env.CUTOVER_TAG,
  CUTOVER_REVIEW: process.env.CUTOVER_REVIEW,
}

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function boot(flags: { tag?: string; review?: string }): Promise<{
  app: INestApplication
  jobs: FakeJobs
}> {
  process.env.NODE_ENV = "production"
  delete process.env.CUTOVER_SCRAPE
  if (flags.tag === undefined) delete process.env.CUTOVER_TAG
  else process.env.CUTOVER_TAG = flags.tag
  if (flags.review === undefined) delete process.env.CUTOVER_REVIEW
  else process.env.CUTOVER_REVIEW = flags.review

  const jobs = new FakeJobs()
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JobsService)
    .useValue(jobs)
    .compile()
  const app = moduleRef.createNestApplication()
  await app.init()
  return { app, jobs }
}

afterEach(() => {
  restoreEnv("NODE_ENV")
  restoreEnv("CUTOVER_SCRAPE")
  restoreEnv("CUTOVER_TAG")
  restoreEnv("CUTOVER_REVIEW")
})

describe.sequential("pipeline family bootstrap", () => {
  it("leaves tag and review ownership absent under production-safe defaults", async () => {
    const { app, jobs } = await boot({})
    try {
      expect(jobs.registered).toEqual([])
    } finally {
      await app.close()
    }
  })

  it("installs tag and review ownership only after their production flags flip", async () => {
    const { app, jobs } = await boot({ tag: "true", review: "true" })
    try {
      expect(jobs.registered.map((queue) => queue.name).toSorted()).toEqual([
        "review",
        "review.dlq",
        "tag",
        "tag.dlq",
      ])
      expect(
        jobs.registered.flatMap((queue) => queue.schedules.map((item) => item.key)).toSorted()
      ).toEqual(["backfill-enrichment", "process-review-queue", "process-tag-queue"])
    } finally {
      await app.close()
    }
  })
})
