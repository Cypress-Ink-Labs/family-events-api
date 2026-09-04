import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { afterEach, describe, expect, it } from "vitest"

import { AppModule } from "../src/app.module.js"
import { JobsService, type QueueSchedule } from "../src/jobs/jobs.service.js"

interface RegisteredQueue {
  name: string
  options: Record<string, unknown>
  schedules: QueueSchedule[]
  localConcurrency: number
}

class FakeJobs {
  registered: RegisteredQueue[] = []

  registerQueue(
    name: string,
    _handler: unknown,
    options: Record<string, unknown> = {},
    config: { schedules?: QueueSchedule[]; localConcurrency?: number } = {}
  ): void {
    this.registered.push({
      name,
      options,
      schedules: config.schedules ?? [],
      localConcurrency: config.localConcurrency ?? 1,
    })
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
  CUTOVER_DIGEST: process.env.CUTOVER_DIGEST,
  CUTOVER_REMINDERS: process.env.CUTOVER_REMINDERS,
  CUTOVER_NOTIFY: process.env.CUTOVER_NOTIFY,
}

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function boot(flags: {
  tag?: string
  review?: string
  digest?: string
  reminders?: string
  notify?: string
}): Promise<{
  app: INestApplication
  jobs: FakeJobs
}> {
  process.env.NODE_ENV = "production"
  delete process.env.CUTOVER_SCRAPE
  if (flags.tag === undefined) delete process.env.CUTOVER_TAG
  else process.env.CUTOVER_TAG = flags.tag
  if (flags.review === undefined) delete process.env.CUTOVER_REVIEW
  else process.env.CUTOVER_REVIEW = flags.review
  if (flags.digest === undefined) delete process.env.CUTOVER_DIGEST
  else process.env.CUTOVER_DIGEST = flags.digest
  if (flags.reminders === undefined) delete process.env.CUTOVER_REMINDERS
  else process.env.CUTOVER_REMINDERS = flags.reminders
  if (flags.notify === undefined) delete process.env.CUTOVER_NOTIFY
  else process.env.CUTOVER_NOTIFY = flags.notify

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
  restoreEnv("CUTOVER_DIGEST")
  restoreEnv("CUTOVER_REMINDERS")
  restoreEnv("CUTOVER_NOTIFY")
})

describe.sequential("pipeline family bootstrap", () => {
  it("leaves every family absent under production-safe defaults", async () => {
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

  it("installs no-retry digest and reminder queues only after their flags flip", async () => {
    const { app, jobs } = await boot({ digest: "true", reminders: "true" })
    try {
      expect(jobs.registered.map((queue) => queue.name).toSorted()).toEqual([
        "digest",
        "digest.dlq",
        "reminders",
        "reminders.dlq",
      ])
      expect(
        jobs.registered.flatMap((queue) => queue.schedules.map((item) => item.key)).toSorted()
      ).toEqual(["send-reminders", "weekly-digest"])
      expect(jobs.registered.find((queue) => queue.name === "digest")?.options).toMatchObject({
        retryLimit: 0,
      })
      expect(jobs.registered.find((queue) => queue.name === "reminders")?.options).toMatchObject({
        retryLimit: 0,
      })
    } finally {
      await app.close()
    }
  })

  it("installs only the serial no-retry notify queue and internal schedule after its flag flips", async () => {
    const { app, jobs } = await boot({ notify: "true" })
    try {
      expect(jobs.registered.map((queue) => queue.name).toSorted()).toEqual([
        "notify",
        "notify.dlq",
      ])
      const notify = jobs.registered.find((queue) => queue.name === "notify")
      expect(notify?.options).toMatchObject({
        deadLetter: "notify.dlq",
        retryLimit: 0,
      })
      expect(notify?.localConcurrency).toBe(1)
      expect(notify?.schedules).toEqual([
        {
          cron: "*/5 * * * *",
          data: { task: "process" },
          key: "process-notification-queue",
        },
      ])
    } finally {
      await app.close()
    }
  })
})
