import { ConfigService } from "@nestjs/config"
import { beforeEach, describe, expect, it, vi } from "vitest"

const pgBoss = vi.hoisted(() => ({
  workCalls: [] as Array<
    [
      name: string,
      options: Record<string, unknown>,
      handler: (jobs: Array<{ id: string; data: object }>) => Promise<void>,
    ]
  >,
}))

vi.mock("pg-boss", () => ({
  PgBoss: class {
    on() {}
    async start() {}
    async stop() {}
    async createQueue() {}
    async schedule() {}
    async send() {
      return "job-1"
    }
    async work(
      name: string,
      options: Record<string, unknown>,
      handler: (jobs: Array<{ id: string; data: object }>) => Promise<void>
    ) {
      pgBoss.workCalls.push([name, options, handler])
      return `worker-${name}`
    }
  },
}))

import { JobsService } from "./jobs.service.js"

function makeService(nodeEnv = "test"): JobsService {
  const config = new ConfigService({
    NODE_ENV: nodeEnv,
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    PGBOSS_SCHEMA: "pgboss",
  })
  return new JobsService(config as unknown as ConfigService<never, true>)
}

beforeEach(() => {
  pgBoss.workCalls = []
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
    expect(handler).toHaveBeenCalledWith({ eventId: "event-a" }, "job-a")
  })
})
