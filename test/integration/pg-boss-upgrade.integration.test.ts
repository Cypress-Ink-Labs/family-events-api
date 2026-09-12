import { randomUUID } from "node:crypto"

import { PgBoss } from "pg-boss"
import { PgBoss as PgBossV12_27 } from "pg-boss-v12-27"
import { Pool } from "pg"
import { describe, expect, it } from "vitest"

import { integrationDatabaseUrl } from "./db.js"

interface UpgradeJob {
  marker: string
}

function boundedConnectionString(input: string): string {
  const url = new URL(input)
  url.searchParams.set("connect_timeout", "5")
  url.searchParams.set("query_timeout", "5000")
  url.searchParams.set("statement_timeout", "5000")
  url.searchParams.set("lock_timeout", "5000")
  return url.toString()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

interface BamRow {
  id: string
  version: number
  name: string
  status: string
  error: string | null
}

interface BossErrorCollector {
  race<T>(promise: Promise<T>): Promise<T>
  assertNone(): void
}

function collectBossErrors(boss: {
  on(event: "error", listener: (error: Error) => void): unknown
}): BossErrorCollector {
  const errors: Error[] = []
  const waiters = new Set<(error: Error) => void>()
  boss.on("error", (error) => {
    errors.push(error)
    for (const reject of waiters) reject(error)
  })
  return {
    async race<T>(promise: Promise<T>): Promise<T> {
      if (errors[0]) throw errors[0]
      let rejectOnError!: (error: Error) => void
      const errorPromise = new Promise<never>((_resolve, reject) => {
        rejectOnError = reject
      })
      waiters.add(rejectOnError)
      try {
        return await Promise.race([promise, errorPromise])
      } finally {
        waiters.delete(rejectOnError)
      }
    },
    assertNone(): void {
      if (errors[0]) throw errors[0]
    },
  }
}

async function waitForBackgroundMigrations(pool: Pool, schema: string): Promise<BamRow[]> {
  const deadline = Date.now() + 35_000
  let rows: BamRow[] = []
  while (Date.now() < deadline) {
    rows = (
      await pool.query<BamRow>(
        `
          SELECT id::text, version, name, status, error
          FROM "${schema}".bam
          WHERE version IN (38, 40)
          ORDER BY created_on, id
        `
      )
    ).rows
    const failed = rows.find((row) => row.status === "failed")
    if (failed) {
      throw new Error(`pg-boss background migration ${failed.name} failed: ${failed.error}`)
    }
    if (rows.length === 3 && rows.every((row) => row.status === "completed")) return rows
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`pg-boss background migrations did not complete: ${JSON.stringify(rows)}`)
}

describe("pg-boss 12.30 schema upgrade", () => {
  it("migrates v37 to v40 without losing queues, schedules, or jobs", async () => {
    const connectionString = boundedConnectionString(integrationDatabaseUrl())
    const schema = `pgboss_upgrade_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const queue = "upgrade-check"
    const deadLetter = `${queue}.dlq`
    const scheduleKey = "upgrade-check-schedule"
    const scheduleCron = "0 0 1 1 *"
    const scheduleData = { marker: "scheduled" }
    const seededMonitorOn = new Date("2999-09-11T12:34:56.000Z")
    const pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    })
    let oldBoss: PgBossV12_27 | null = new PgBossV12_27({
      connectionString,
      schema,
      connectionTimeoutMillis: 5_000,
    })
    let upgradedBoss: PgBoss | null = null
    let primaryFailure: unknown
    const cleanupErrors: unknown[] = []

    try {
      const oldErrors = collectBossErrors(oldBoss)
      await oldErrors.race(oldBoss.start())
      expect(await oldBoss.schemaVersion()).toBe(37)
      await oldBoss.createQueue(deadLetter)
      await oldBoss.createQueue(queue, {
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 900,
        deadLetter,
      })
      await pool.query(`UPDATE "${schema}".queue SET monitor_on = $2 WHERE name = $1`, [
        queue,
        seededMonitorOn,
      ])
      await oldBoss.schedule(queue, scheduleCron, scheduleData, { key: scheduleKey })
      const preUpgradeJobId = await oldBoss.send(queue, { marker: "before-upgrade" })
      expect(preUpgradeJobId).toEqual(expect.any(String))
      oldErrors.assertNone()
      await oldErrors.race(oldBoss.stop({ close: true }))
      oldBoss = null
      await pool.query(`UPDATE "${schema}".version SET bam_on = NULL`)

      upgradedBoss = new PgBoss({
        connectionString,
        schema,
        connectionTimeoutMillis: 5_000,
        bamIntervalSeconds: 10,
      })
      const firstUpgradeErrors = collectBossErrors(upgradedBoss)
      await firstUpgradeErrors.race(upgradedBoss.start())
      expect(await upgradedBoss.schemaVersion()).toBe(40)
      await expect(upgradedBoss.getQueue(queue)).resolves.toMatchObject({
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 900,
        deadLetter,
      })
      await expect(upgradedBoss.getSchedules(queue, scheduleKey)).resolves.toMatchObject([
        {
          name: queue,
          key: scheduleKey,
          cron: scheduleCron,
          data: scheduleData,
        },
      ])

      const firstCompletion = deferred<{ id: string; data: UpgradeJob }>()
      await upgradedBoss.work<UpgradeJob>(queue, { batchSize: 1 }, async ([job]) => {
        if (job) firstCompletion.resolve({ id: job.id, data: job.data })
      })
      await expect(
        firstUpgradeErrors.race(
          withTimeout(firstCompletion.promise, 10_000, "pre-upgrade job was not processed")
        )
      ).resolves.toEqual({
        id: preUpgradeJobId,
        data: { marker: "before-upgrade" },
      })

      const columns = await pool.query<{ table_name: string; column_name: string }>(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = $1
            AND (
              (table_name = 'version' AND column_name IN ('reindex_on', 'monitor_backoff_on'))
              OR (table_name = 'queue' AND column_name = 'monitor_claim_on')
            )
          ORDER BY table_name, column_name
        `,
        [schema]
      )
      expect(columns.rows).toEqual([
        { table_name: "queue", column_name: "monitor_claim_on" },
        { table_name: "version", column_name: "monitor_backoff_on" },
        { table_name: "version", column_name: "reindex_on" },
      ])
      const monitorSeed = await pool.query<{ matches_seed: boolean }>(
        `
          SELECT monitor_on = $2 AND monitor_claim_on = $2 AS matches_seed
          FROM "${schema}".queue
          WHERE name = $1
        `,
        [queue, seededMonitorOn]
      )
      expect(monitorSeed.rows).toEqual([{ matches_seed: true }])

      const bamSnapshot = await firstUpgradeErrors.race(waitForBackgroundMigrations(pool, schema))
      expect(bamSnapshot.map(({ id: _id, ...row }) => row)).toEqual([
        {
          version: 38,
          name: "key_strict_fifo_head_index",
          status: "completed",
          error: null,
        },
        {
          version: 40,
          name: "fetch_index_priority_build",
          status: "completed",
          error: null,
        },
        {
          version: 40,
          name: "fetch_index_retire",
          status: "completed",
          error: null,
        },
      ])
      const indexes = await pool.query<{ indexname: string }>(
        `
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = $1
            AND indexname IN ('job_common_i5', 'job_common_i10', 'job_common_i11')
          ORDER BY indexname
        `,
        [schema]
      )
      expect(indexes.rows).toEqual([
        { indexname: "job_common_i10" },
        { indexname: "job_common_i11" },
      ])

      firstUpgradeErrors.assertNone()
      await firstUpgradeErrors.race(upgradedBoss.stop({ close: true }))
      upgradedBoss = new PgBoss({
        connectionString,
        schema,
        connectionTimeoutMillis: 5_000,
        bamIntervalSeconds: 10,
      })
      const restartErrors = collectBossErrors(upgradedBoss)
      await restartErrors.race(upgradedBoss.start())
      expect(await upgradedBoss.schemaVersion()).toBe(40)
      await expect(upgradedBoss.getSchedules(queue, scheduleKey)).resolves.toMatchObject([
        {
          name: queue,
          key: scheduleKey,
          cron: scheduleCron,
          data: scheduleData,
        },
      ])
      const restartedBam = await pool.query<BamRow>(
        `
          SELECT id::text, version, name, status, error
          FROM "${schema}".bam
          WHERE version IN (38, 40)
          ORDER BY created_on, id
        `
      )
      expect(restartedBam.rows).toEqual(bamSnapshot)

      const secondCompletion = deferred<{ id: string; data: UpgradeJob }>()
      await upgradedBoss.work<UpgradeJob>(queue, { batchSize: 1 }, async ([job]) => {
        if (job) secondCompletion.resolve({ id: job.id, data: job.data })
      })
      const postUpgradeJobId = await upgradedBoss.send(queue, { marker: "after-upgrade" })
      await expect(
        restartErrors.race(
          withTimeout(secondCompletion.promise, 10_000, "post-upgrade job was not processed")
        )
      ).resolves.toEqual({
        id: postUpgradeJobId,
        data: { marker: "after-upgrade" },
      })
      restartErrors.assertNone()
    } catch (error) {
      primaryFailure = error
    } finally {
      if (oldBoss !== null) {
        await withTimeout(oldBoss.stop({ close: true }), 10_000, "old pg-boss did not stop").catch(
          (error) => cleanupErrors.push(error)
        )
      }
      if (upgradedBoss !== null) {
        await withTimeout(
          upgradedBoss.stop({ close: true }),
          10_000,
          "upgraded pg-boss did not stop"
        ).catch((error) => cleanupErrors.push(error))
      }
      try {
        await withTimeout(
          pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
          10_000,
          "pg-boss test schema cleanup timed out"
        )
      } catch (error) {
        cleanupErrors.push(error)
      }
      await pool.end().catch((error) => cleanupErrors.push(error))
    }
    if (primaryFailure !== undefined) throw primaryFailure
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
  }, 100_000)
})
