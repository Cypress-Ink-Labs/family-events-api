import { randomUUID } from "node:crypto"

import { ConfigService } from "@nestjs/config"
import { PgBoss } from "pg-boss"
import { describe, expect, it } from "vitest"

import { JobsService } from "../../src/jobs/jobs.service.js"
import { integrationDatabaseUrl } from "./db.js"

describe("JobsService queue reconciliation", () => {
  it("overwrites stale retry settings on a pre-existing queue", async () => {
    const connectionString = integrationDatabaseUrl()
    const schema = `pgboss_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const seed = new PgBoss({ connectionString, schema })
    await seed.start()
    await seed.createQueue("email", { retryLimit: 3, retryDelay: 60 })
    await seed.stop({ close: true })

    const service = new JobsService(
      new ConfigService({
        NODE_ENV: "development",
        DATABASE_URL: connectionString,
        PGBOSS_SCHEMA: schema,
      }) as unknown as ConfigService<never, true>
    )
    service.registerQueue("email", null, {
      name: "email",
      retryLimit: 0,
      retryDelay: 30,
    })

    try {
      await service.onApplicationBootstrap()
      const inspector = new PgBoss({ connectionString, schema })
      await inspector.start()
      try {
        await expect(inspector.getQueue("email")).resolves.toMatchObject({
          retryLimit: 0,
          retryDelay: 30,
        })
      } finally {
        await inspector.stop({ close: true })
      }
    } finally {
      await service.onApplicationShutdown()
    }
  })
})
