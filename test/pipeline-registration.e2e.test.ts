import type { INestApplication } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { validateEnv } from "../src/config/env.js"
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
  scheduleRemovals: Array<{ queue: string; key: string }> = []

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

  registerScheduleRemoval(queue: string, key: string): void {
    this.scheduleRemovals.push({ queue, key })
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
  CUTOVER_MAINTENANCE: process.env.CUTOVER_MAINTENANCE,
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
  maintenance?: string
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
  if (flags.maintenance === undefined) delete process.env.CUTOVER_MAINTENANCE
  else process.env.CUTOVER_MAINTENANCE = flags.maintenance

  const jobs = new FakeJobs()
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(validateEnv(process.env)))
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
  restoreEnv("CUTOVER_MAINTENANCE")
})

describe.sequential("pipeline family bootstrap", () => {
  it("leaves every family absent under production-safe defaults", async () => {
    const { app, jobs } = await boot({})
    try {
      expect(jobs.registered).toEqual([])
      expect(jobs.scheduleRemovals.toSorted((a, b) => a.queue.localeCompare(b.queue))).toEqual([
        { queue: "maintenance", key: "daily-maintenance" },
        { queue: "notify", key: "process-notification-queue" },
        { queue: "transactional-email", key: "transactional-email-outbox" },
      ])
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

  it("installs serial notification and transactional delivery queues only after notify ownership flips", async () => {
    const { app, jobs } = await boot({ notify: "true" })
    try {
      expect(jobs.registered.map((queue) => queue.name).toSorted()).toEqual([
        "notify",
        "notify.dlq",
        "transactional-email",
      ])
      const transactional = jobs.registered.find((queue) => queue.name === "transactional-email")
      expect(transactional?.options).toMatchObject({ retryLimit: 0 })
      expect(transactional?.localConcurrency).toBe(1)
      expect(transactional?.schedules).toEqual([
        { cron: "* * * * *", data: { task: "process" }, key: "transactional-email-outbox" },
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
      expect(jobs.scheduleRemovals).toEqual([{ queue: "maintenance", key: "daily-maintenance" }])
    } finally {
      await app.close()
    }
  })
  it("installs only the dedicated maintenance family after its explicit production flag", async () => {
    const { app, jobs } = await boot({ maintenance: "true" })
    try {
      expect(jobs.registered.map((queue) => queue.name).toSorted()).toEqual([
        "maintenance",
        "maintenance.dlq",
      ])
      expect(jobs.registered.find((queue) => queue.name === "maintenance")).toMatchObject({
        localConcurrency: 1,
        schedules: [
          { cron: "15 3 * * *", data: { task: "daily-maintenance" }, key: "daily-maintenance" },
        ],
      })
      expect(jobs.scheduleRemovals.toSorted((a, b) => a.queue.localeCompare(b.queue))).toEqual([
        { queue: "notify", key: "process-notification-queue" },
        { queue: "transactional-email", key: "transactional-email-outbox" },
      ])
    } finally {
      await app.close()
    }
  })
})
