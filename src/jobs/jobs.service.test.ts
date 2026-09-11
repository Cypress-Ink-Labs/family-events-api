import { ConfigService } from "@nestjs/config"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { StructuredLogSink } from "../observability/structured-log.js"

const pgBoss = vi.hoisted(() => ({
  updateQueueCalls: [] as Array<[name: string, options: Record<string, unknown>]>,
  workCalls: [] as Array<
    [
      name: string,
      options: Record<string, unknown>,
      handler: (jobs: Array<{ id: string; data: object; signal?: AbortSignal }>) => Promise<void>,
    ]
  >,
  unscheduleCalls: [] as Array<[queue: string, key?: string]>,
}))

vi.mock("pg-boss", () => ({
  PgBoss: class {
    on() {}
    async start() {}
    async stop() {}
    async createQueue() {}
    async updateQueue(name: string, options: Record<string, unknown>) {
      pgBoss.updateQueueCalls.push([name, options])
    }
    async schedule() {}
    async unschedule(queue: string, key?: string) {
      pgBoss.unscheduleCalls.push([queue, key])
    }
    async send() {
      return "job-1"
    }
    async work(
      name: string,
      options: Record<string, unknown>,
      handler: (jobs: Array<{ id: string; data: object; signal?: AbortSignal }>) => Promise<void>
    ) {
      pgBoss.workCalls.push([name, options, handler])
      return `worker-${name}`
    }
  },
}))

import { JobsService } from "./jobs.service.js"

function makeService(nodeEnv = "test", sink?: StructuredLogSink): JobsService {
  const config = new ConfigService({
    NODE_ENV: nodeEnv,
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    PGBOSS_SCHEMA: "pgboss",
  })
  return new JobsService(config as unknown as ConfigService<never, true>, sink)
}

beforeEach(() => {
  pgBoss.updateQueueCalls = []
  pgBoss.workCalls = []
  pgBoss.unscheduleCalls = []
})

describe("JobsService", () => {
  it("does not start pg-boss under NODE_ENV=test", async () => {
    const service = makeService()
    service.registerQueue("noop", async () => {})
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined()
  })

  it("rejects send() before pg-boss is started", async () => {
    const service = makeService()
    await expect(service.send("noop", {})).rejects.toThrow(/not started/)
  })

  it("shutdown is a no-op when never started", async () => {
    await expect(makeService().onApplicationShutdown()).resolves.toBeUndefined()
  })

  it("isolates job settlement with single-job fetches and local worker concurrency", async () => {
    const handler = vi.fn(async () => {})
    const service = makeService("development")
    service.registerQueue("events", handler, { name: "events" }, { localConcurrency: 3 })

    await service.onApplicationBootstrap()

    expect(pgBoss.workCalls).toHaveLength(1)
    const [name, options, callback] = pgBoss.workCalls[0]!
    expect(name).toBe("events")
    expect(options).toEqual({ batchSize: 1, localConcurrency: 3 })

    await callback([{ id: "job-a", data: { eventId: "event-a" } }])
    expect(handler).toHaveBeenCalledWith({ eventId: "event-a" }, "job-a", undefined)
  })

  it("forwards the job cancellation signal to its registered handler", async () => {
    const controller = new AbortController()
    const handler = vi.fn(async (_data: object, _jobId: string, signal?: AbortSignal) => {
      signal?.throwIfAborted()
    })
    const service = makeService("development")
    service.registerQueue("reminders", handler)
    await service.onApplicationBootstrap()
    const callback = pgBoss.workCalls[0]![2]

    await callback([{ id: "job-a", data: {}, signal: controller.signal }])
    expect(handler).toHaveBeenCalledWith({}, "job-a", controller.signal)

    controller.abort(new Error("job expired"))
    await expect(callback([{ id: "job-b", data: {}, signal: controller.signal }])).rejects.toThrow(
      "job expired"
    )
  })

  it("reconciles mutable options when a queue already exists", async () => {
    const service = makeService("development")
    service.registerQueue("email", null, {
      name: "email",
      policy: "standard",
      expireInSeconds: 43_200,
      retryLimit: 0,
      retryDelay: 30,
      deadLetter: "email.dlq",
    })

    await service.onApplicationBootstrap()

    expect(pgBoss.updateQueueCalls).toEqual([
      [
        "email",
        {
          expireInSeconds: 43_200,
          retryLimit: 0,
          retryDelay: 30,
          deadLetter: "email.dlq",
        },
      ],
    ])
  })

  it("removes registered durable schedules during bootstrap", async () => {
    const service = makeService("development")
    service.registerScheduleRemoval("notify", "process-notification-queue")

    await service.onApplicationBootstrap()

    expect(pgBoss.unscheduleCalls).toEqual([["notify", "process-notification-queue"]])
  })

  it("logs worker success with queue and job correlation", async () => {
    const lines: string[] = []
    const service = makeService("development", { write: (line) => lines.push(line) })
    service.registerQueue("events", async () => undefined)
    await service.onApplicationBootstrap()

    await pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])

    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "worker_job_completed",
      queue: "events",
      job_id: "job-a",
      outcome: "success",
    })
  })

  it("logs a safe failure and rethrows the identical error so pg-boss can retry", async () => {
    const lines: string[] = []
    const failure = Object.assign(new Error("payload secret"), { code: "TEMP_FAILURE" })
    const service = makeService("development", { write: (line) => lines.push(line) })
    service.registerQueue("events", async () => {
      throw failure
    })
    await service.onApplicationBootstrap()

    await expect(pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])).rejects.toBe(failure)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      queue: "events",
      job_id: "job-a",
      outcome: "failure",
      error_category: "unhandled_worker_error",
      error_code: "TEMP_FAILURE",
    })
    expect(lines[0]).not.toContain("payload secret")
  })
})
