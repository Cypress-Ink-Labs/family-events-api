import { randomUUID } from "node:crypto"

import { ConfigService } from "@nestjs/config"
import { PgBoss } from "pg-boss"
import { Pool } from "pg"
import { describe, expect, it } from "vitest"

import { SCHEDULED_NOTIFICATION_EXPIRE_SECONDS } from "../../src/notifications/scheduled-notification.js"
import { JobsService } from "../../src/jobs/jobs.service.js"
import { emitStructuredLog } from "../../src/observability/structured-log.js"
import { integrationDatabaseUrl } from "./db.js"

describe("JobsService queue reconciliation", () => {
  it("overwrites stale retry and expiration settings on a pre-existing queue", async () => {
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
      expireInSeconds: SCHEDULED_NOTIFICATION_EXPIRE_SECONDS,
      retryLimit: 0,
      retryDelay: 30,
    })
    service.registerScheduleRemoval("email", "stale-email-schedule")

    let seed: PgBoss | null = new PgBoss({ connectionString, schema })
    const cleanup = new Pool({ connectionString })
    try {
      await seed.start()
      await seed.createQueue("email", { retryLimit: 3, retryDelay: 60, expireInSeconds: 60 })
      await seed.schedule("email", "0 * * * *", {}, { key: "stale-email-schedule" })
      await seed.stop({ close: true })
      seed = null

      await service.onApplicationBootstrap()
      const inspector = new PgBoss({ connectionString, schema })
      await inspector.start()
      try {
        await expect(inspector.getQueue("email")).resolves.toMatchObject({
          expireInSeconds: SCHEDULED_NOTIFICATION_EXPIRE_SECONDS,
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

  it("persists bounded redacted structured logs in completed job output", async () => {
    const connectionString = integrationDatabaseUrl()
    const schema = `pgboss_output_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const service = new JobsService(
      new ConfigService({
        NODE_ENV: "development",
        DATABASE_URL: connectionString,
        PGBOSS_SCHEMA: schema,
      }) as unknown as ConfigService<never, true>,
      { write: () => undefined }
    )
    service.registerQueue("observable", async () => {
      emitStructuredLog({
        event: "observable_detail",
        authorization: "Bearer integration-secret",
      })
    })
    const database = new Pool({ connectionString })

    try {
      await service.onApplicationBootstrap()
      const jobId = await service.send("observable", { ignored: "payload" })
      expect(jobId).toEqual(expect.any(String))

      let row:
        | {
            state: string
            output: {
              outcome: string
              log_events: Array<Record<string, unknown>>
              dropped_events: number
            } | null
            output_bytes: number
          }
        | undefined
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        row = (
          await database.query(
            `SELECT state, output, octet_length(output::text)::int AS output_bytes
             FROM "${schema}".job_common
             WHERE id = $1::uuid`,
            [jobId]
          )
        ).rows[0]
        if (row?.state === "completed") break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect(row).toMatchObject({
        state: "completed",
        output: {
          outcome: "success",
          dropped_events: 0,
          log_events: [
            { event: "worker_log", queue: "observable", job_id: jobId },
            {
              event: "worker_job_completed",
              queue: "observable",
              job_id: jobId,
              outcome: "success",
            },
          ],
        },
      })
      expect(row!.output_bytes).toBeLessThanOrEqual(32 * 1024)
      expect(JSON.stringify(row?.output)).not.toContain("integration-secret")
      expect(JSON.stringify(row?.output)).not.toContain("payload")
    } finally {
      try {
        await service.onApplicationShutdown()
      } finally {
        try {
          await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        } finally {
          await database.end()
        }
      }
    }
  })

  it("persists sanitized bounded failure output while preserving retries", async () => {
    const connectionString = integrationDatabaseUrl()
    const schema = `pgboss_failure_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    let attempts = 0
    const service = new JobsService(
      new ConfigService({
        NODE_ENV: "development",
        DATABASE_URL: connectionString,
        PGBOSS_SCHEMA: schema,
      }) as unknown as ConfigService<never, true>,
      { write: () => undefined }
    )
    service.registerQueue("failing.dlq", null)
    service.registerQueue(
      "failing",
      async () => {
        attempts++
        emitStructuredLog({
          event: "provider_failure",
          request_payload: "integration-secret",
          failed: 1,
        })
        throw Object.assign(new Error("raw integration-secret"), {
          code: "TEMP_FAILURE",
          response_headers: { authorization: "Bearer integration-secret" },
        })
      },
      { name: "failing", retryLimit: 1, retryDelay: 2, deadLetter: "failing.dlq" }
    )
    const database = new Pool({ connectionString })

    try {
      await service.onApplicationBootstrap()
      const jobId = await service.send("failing", { ignored: "payload" })
      expect(jobId).toEqual(expect.any(String))

      let row:
        | {
            state: string
            retry_count: number
            output: {
              outcome: string
              log_events: Array<Record<string, unknown>>
              dropped_events: number
              error_category: string
            } | null
            output_bytes: number
          }
        | undefined
      let retryOutputWasSafe = false
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        row = (
          await database.query(
            `SELECT state, retry_count, output,
                    octet_length(output::text)::int AS output_bytes
             FROM "${schema}".job_common
             WHERE id = $1::uuid`,
            [jobId]
          )
        ).rows[0]
        if (row?.state === "retry") {
          expect(row.output_bytes).toBeLessThanOrEqual(32 * 1024)
          expect(JSON.stringify(row.output)).not.toContain("integration-secret")
          expect(row.output).toMatchObject({
            outcome: "failure",
            error_category: "unhandled_worker_error",
          })
          retryOutputWasSafe = true
        }
        if (row?.state === "failed") break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect(attempts).toBe(2)
      expect(retryOutputWasSafe).toBe(true)
      expect(row).toMatchObject({
        state: "failed",
        retry_count: 1,
        output: {
          outcome: "failure",
          error_category: "unhandled_worker_error",
          log_events: [
            {
              event: "worker_log",
              queue: "failing",
              job_id: jobId,
              failed: 1,
            },
            {
              event: "worker_job_completed",
              queue: "failing",
              job_id: jobId,
              outcome: "failure",
            },
          ],
        },
      })
      expect(row!.output_bytes).toBeLessThanOrEqual(32 * 1024)
      expect(JSON.stringify(row?.output)).not.toContain("integration-secret")
      expect(JSON.stringify(row?.output)).not.toContain("payload")
      expect(JSON.stringify(row?.output)).not.toContain("headers")
      expect(JSON.stringify(row?.output)).not.toContain("stack")

      const deadLetter = (
        await database.query(
          `SELECT state, retry_count, source_id::text, source_retry_count, output,
                  octet_length(output::text)::int AS output_bytes
           FROM "${schema}".job_common
           WHERE name = 'failing.dlq' AND source_id = $1::uuid`,
          [jobId]
        )
      ).rows[0]
      expect(deadLetter).toMatchObject({
        state: "created",
        retry_count: 0,
        source_id: jobId,
        source_retry_count: 1,
        output: row!.output,
      })
      expect(deadLetter.output_bytes).toBeLessThanOrEqual(32 * 1024)
      expect(JSON.stringify(deadLetter.output)).not.toContain("integration-secret")
    } finally {
      try {
        await service.onApplicationShutdown()
      } finally {
        try {
          await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        } finally {
          await database.end()
        }
      }
    }
  }, 20_000)
})
