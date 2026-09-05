import { randomUUID } from "node:crypto"

import { ConfigService } from "@nestjs/config"
import { PgBoss } from "pg-boss"
import { Pool } from "pg"
import { describe, expect, it } from "vitest"

import { JobsService } from "../../src/jobs/jobs.service.js"
import { integrationDatabaseUrl } from "./db.js"

describe("JobsService queue reconciliation", () => {
  it("overwrites stale retry settings on a pre-existing queue", async () => {
    const connectionString = integrationDatabaseUrl()
    const schema = `pgboss_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`
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
    service.registerScheduleRemoval("email", "stale-email-schedule")

    let seed: PgBoss | null = new PgBoss({ connectionString, schema })
    const cleanup = new Pool({ connectionString })
    try {
      await seed.start()
      await seed.createQueue("email", { retryLimit: 3, retryDelay: 60 })
      await seed.schedule("email", "0 * * * *", {}, { key: "stale-email-schedule" })
      await seed.stop({ close: true })
      seed = null

      await service.onApplicationBootstrap()
      const inspector = new PgBoss({ connectionString, schema })
      await inspector.start()
      try {
        await expect(inspector.getQueue("email")).resolves.toMatchObject({
          retryLimit: 0,
          retryDelay: 30,
        })
        await expect(inspector.getSchedules("email", "stale-email-schedule")).resolves.toEqual([])
      } finally {
        await inspector.stop({ close: true })
      }
    } finally {
      if (seed !== null) await seed.stop({ close: true }).catch(() => undefined)
      try {
        await service.onApplicationShutdown()
      } finally {
        try {
          await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        } finally {
          await cleanup.end()
        }
      }
    }
  })
})
