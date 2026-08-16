import { ConfigService } from "@nestjs/config"
import { describe, expect, it } from "vitest"

import { JobsService } from "./jobs.service.js"

function makeService(): JobsService {
  const config = new ConfigService({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    PGBOSS_SCHEMA: "pgboss",
  })
  return new JobsService(config as unknown as ConfigService<never, true>)
}

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
})
