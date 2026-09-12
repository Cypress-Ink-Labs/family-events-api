import { ConfigService } from "@nestjs/config"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  currentLogCorrelation,
  emitStructuredLog,
  type StructuredLogSink,
} from "../observability/structured-log.js"

const pgBoss = vi.hoisted(() => ({
  updateQueueCalls: [] as Array<[name: string, options: Record<string, unknown>]>,
  workCalls: [] as Array<
    [
      name: string,
      options: Record<string, unknown>,
      handler: (
        jobs: Array<{ id: string; data: object; signal?: AbortSignal }>
      ) => Promise<unknown>,
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
      handler: (jobs: Array<{ id: string; data: object; signal?: AbortSignal }>) => Promise<unknown>
    ) {
      pgBoss.workCalls.push([name, options, handler])
      return `worker-${name}`
    }
  },
}))

import { JOB_OUTPUT_MAX_BYTES, JobsService } from "./jobs.service.js"

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
    expect(options).toEqual({ batchSize: 1, localConcurrency: 3, perJobResults: true })

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
    await expect(
      callback([{ id: "job-b", data: {}, signal: controller.signal }])
    ).resolves.toMatchObject([
      {
        id: "job-b",
        status: "failed",
        output: { outcome: "failure", error_category: "unhandled_worker_error" },
      },
    ])
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

    const [result] = (await pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])) as Array<{
      output: Record<string, unknown>
    }>
    const output = result!.output

    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "worker_job_completed",
      queue: "events",
      job_id: "job-a",
      outcome: "success",
    })
    expect(output).toMatchObject({
      outcome: "success",
      dropped_events: 0,
      log_events: [{ event: "worker_job_completed", outcome: "success" }],
    })
    expect(Number.isFinite((output as { duration_ms: number }).duration_ms)).toBe(true)
  })

  it("forwards unchanged redacted lines and persists no raw secret", async () => {
    const lines: string[] = []
    const service = makeService("development", { write: (line) => lines.push(line) })
    service.registerQueue("events", async () => {
      emitStructuredLog({ event: "detail", authorization: "Bearer top-secret" })
    })
    await service.onApplicationBootstrap()

    const [result] = (await pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])) as Array<{
      output: { log_events: unknown[] }
    }>
    const output = result!.output
    expect(JSON.parse(lines[0]!)).toEqual({
      event: "detail",
      authorization: "[REDACTED]",
    })
    expect(output.log_events[0]).toEqual({
      event: "worker_log",
      queue: "events",
      job_id: "job-a",
    })
    expect(JSON.stringify(output)).not.toContain("top-secret")
    expect(JSON.stringify(output)).not.toContain("authorization")
  })

  it("bounds persisted events by count while retaining completion", async () => {
    const service = makeService("development", { write: () => undefined })
    service.registerQueue("events", async () => {
      for (let index = 0; index < 30; index++) {
        emitStructuredLog({ event: "detail", index })
      }
    })
    await service.onApplicationBootstrap()

    const [result] = (await pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])) as Array<{
      output: { log_events: Array<{ event: string }>; dropped_events: number }
    }>
    const output = result!.output
    expect(output.log_events).toHaveLength(25)
    expect(output.dropped_events).toBe(6)
    expect(output.log_events.at(-1)?.event).toBe("worker_job_completed")
  })

  it("bounds persisted events by bytes while retaining completion", async () => {
    const service = makeService("development", { write: () => undefined })
    const metrics = {
      approved: Number.MAX_SAFE_INTEGER,
      attempts: Number.MAX_SAFE_INTEGER,
      backfilled: Number.MAX_SAFE_INTEGER,
      claimed: Number.MAX_SAFE_INTEGER,
      coordsSet: Number.MAX_SAFE_INTEGER,
      dead: Number.MAX_SAFE_INTEGER,
      dropped: Number.MAX_SAFE_INTEGER,
      durationMs: Number.MAX_SAFE_INTEGER,
      emailed: Number.MAX_SAFE_INTEGER,
      errors: Number.MAX_SAFE_INTEGER,
      failed: Number.MAX_SAFE_INTEGER,
      generated: Number.MAX_SAFE_INTEGER,
      imagesSet: Number.MAX_SAFE_INTEGER,
      pendingAfter: Number.MAX_SAFE_INTEGER,
      processed: Number.MAX_SAFE_INTEGER,
      reaped: Number.MAX_SAFE_INTEGER,
      refreshed: Number.MAX_SAFE_INTEGER,
      rejected: Number.MAX_SAFE_INTEGER,
      retrying: Number.MAX_SAFE_INTEGER,
      sent: Number.MAX_SAFE_INTEGER,
      skipped: Number.MAX_SAFE_INTEGER,
      started: Number.MAX_SAFE_INTEGER,
      succeeded: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
      tracked: Number.MAX_SAFE_INTEGER,
      updated: Number.MAX_SAFE_INTEGER,
      upserted: Number.MAX_SAFE_INTEGER,
    }
    service.registerQueue("events", async () => {
      for (let index = 0; index < 10; index++) {
        emitStructuredLog({
          event: "detail",
          tracking: { ...metrics },
          attribution_backfill: { ...metrics },
          attributionBackfill: { ...metrics },
          email: { ...metrics },
          in_app: { ...metrics },
          parent_tips: { ...metrics },
          parentTips: { ...metrics },
          push: { ...metrics },
          telegram: { ...metrics },
          unsplash_tracking: { ...metrics },
        })
      }
    })
    await service.onApplicationBootstrap()

    const [result] = (await pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])) as Array<{
      output: { log_events: Array<{ event: string }>; dropped_events: number }
    }>
    const output = result!.output
    expect(output.log_events.length).toBeLessThan(10)
    expect(output.log_events.length).toBeLessThanOrEqual(25)
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(JOB_OUTPUT_MAX_BYTES)
    expect(output.dropped_events).toBeGreaterThan(0)
    expect(output.log_events.at(-1)?.event).toBe("worker_job_completed")
  })

  it("projects direct sink writes through the persistence allowlist", async () => {
    const service = makeService("development", { write: () => undefined })
    service.registerQueue("events", async () => {
      currentLogCorrelation().sink?.write(
        JSON.stringify({
          event: "attacker_controlled",
          provider: "sk_live_SECRET",
          error_code: "UPPERCASE_SECRET",
          secret: 123_456,
          credentials: { count: 9 },
          request_payload: "raw-secret",
          response_headers: { authorization: "Bearer raw-secret" },
          count: 2,
        })
      )
    })
    await service.onApplicationBootstrap()

    const [result] = (await pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])) as Array<{
      output: { log_events: unknown[] }
    }>
    const output = result!.output
    expect(JSON.stringify(output)).not.toContain("raw-secret")
    expect(JSON.stringify(output)).not.toContain("sk_live_SECRET")
    expect(JSON.stringify(output)).not.toContain("UPPERCASE_SECRET")
    expect(JSON.stringify(output)).not.toContain("123456")
    expect(output.log_events[0]).toEqual({
      event: "worker_log",
      queue: "events",
      job_id: "job-a",
      count: 2,
    })
  })

  it("does not fail a job or persist a sink exception when forwarding throws", async () => {
    const service = makeService("development", {
      write() {
        throw new Error("sink credential secret")
      },
    })
    service.registerQueue("events", async () => {
      emitStructuredLog({ event: "detail", count: 1 })
    })
    await service.onApplicationBootstrap()

    const result = await pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])
    expect(result).toMatchObject([
      {
        id: "job-a",
        status: "completed",
        output: {
          outcome: "success",
          log_events: [
            { event: "worker_log", count: 1 },
            { event: "worker_job_completed", outcome: "success" },
          ],
        },
      },
    ])
    expect(JSON.stringify(result)).not.toContain("sink credential secret")
  })

  it("isolates concurrently collected job output", async () => {
    const service = makeService("development", { write: () => undefined })
    service.registerQueue("events", async (_data, jobId) => {
      await Promise.resolve()
      emitStructuredLog({ event: "detail", index: jobId === "job-a" ? 1 : 2 })
    })
    await service.onApplicationBootstrap()
    const callback = pgBoss.workCalls[0]![2]

    const [firstResult, secondResult] = (await Promise.all([
      callback([{ id: "job-a", data: {} }]),
      callback([{ id: "job-b", data: {} }]),
    ])) as Array<Array<{ output: { log_events: Array<{ job_id?: string }> } }>>
    const first = firstResult![0]!.output
    const second = secondResult![0]!.output
    expect(first.log_events).toEqual([
      { event: "worker_log", queue: "events", job_id: "job-a", index: 1 },
      expect.objectContaining({
        event: "worker_job_completed",
        queue: "events",
        job_id: "job-a",
      }),
    ])
    expect(second.log_events).toEqual([
      { event: "worker_log", queue: "events", job_id: "job-b", index: 2 },
      expect.objectContaining({
        event: "worker_job_completed",
        queue: "events",
        job_id: "job-b",
      }),
    ])
  })

  it("returns a safe failed disposition so pg-boss can retry without serializing the error", async () => {
    const lines: string[] = []
    const failure = Object.assign(new Error("payload secret"), { code: "TEMP_FAILURE" })
    const service = makeService("development", { write: (line) => lines.push(line) })
    service.registerQueue("events", async () => {
      throw failure
    })
    await service.onApplicationBootstrap()

    await expect(pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])).resolves.toMatchObject([
      {
        id: "job-a",
        status: "failed",
        output: {
          outcome: "failure",
          error_category: "unhandled_worker_error",
          log_events: [
            expect.objectContaining({
              event: "worker_job_completed",
              outcome: "failure",
            }),
          ],
        },
      },
    ])
    expect(JSON.parse(lines[0]!)).toMatchObject({
      queue: "events",
      job_id: "job-a",
      outcome: "failure",
      error_category: "unhandled_worker_error",
      error_code: "TEMP_FAILURE",
    })
    expect(lines[0]).not.toContain("payload secret")
  })

  it("sanitizes unusual rejection values without reading hostile properties", async () => {
    const rejection = Object.defineProperties(
      {},
      {
        code: {
          get() {
            throw new Error("secret getter")
          },
        },
        name: {
          get() {
            throw new Error("secret getter")
          },
        },
      }
    )
    const service = makeService("development", { write: () => undefined })
    service.registerQueue("events", async () => Promise.reject(rejection))
    await service.onApplicationBootstrap()

    const result = await pgBoss.workCalls[0]![2]([{ id: "job-a", data: {} }])
    expect(result).toMatchObject([
      {
        id: "job-a",
        status: "failed",
        output: {
          outcome: "failure",
          error_category: "unhandled_worker_error",
        },
      },
    ])
    expect(JSON.stringify(result)).not.toContain("secret getter")
  })
})
