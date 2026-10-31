import { Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common"
import type { PoolClient } from "pg"
import { DbService } from "../db/db.service.js"
import { JobsService } from "../jobs/jobs.service.js"
import { CronGateService } from "./cron-gate.service.js"
import { FAMILIES, isLegacyReplacementSchedule } from "./families.js"
import { isFamilyEnabled } from "./flags.js"

export const DAILY_MAINTENANCE_LOCK_KEY = 1_180_030_052
export const RETENTION_BATCH_SIZE = 1000
const RETENTION_MAX_PASSES = 200
export const DATABASE_SIZE_WARNING_BYTES = 400_000_000

type RetentionPass = Record<string, number>

@Injectable()
export class MaintenanceQueueService implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceQueueService.name)
  constructor(
    private readonly jobs: JobsService,
    private readonly gate: CronGateService,
    private readonly db: DbService,
    @Optional() private readonly env?: Record<string, string | undefined>
  ) {}
  onModuleInit() {
    if (!isFamilyEnabled("maintenance", this.env ?? process.env)) {
      this.jobs.registerScheduleRemoval("maintenance", "daily-maintenance")
      this.logger.log("maintenance family disabled; API schedule removal registered")
      return
    }
    const family = FAMILIES.maintenance
    this.jobs.registerQueue(family.deadLetter, null)
    this.jobs.registerQueue(
      family.queue,
      (data: { task?: unknown }) => this.handleJob(data),
      {
        name: family.queue,
        deadLetter: family.deadLetter,
        retryLimit: family.retryLimit,
        retryDelay: family.retryDelay,
        retryBackoff: family.retryBackoff,
      },
      {
        schedules: family.schedules.map((schedule) => ({
          cron: schedule.cron,
          data: { task: schedule.task },
          key: schedule.key,
        })),
        localConcurrency: family.concurrency,
      }
    )
  }
  async handleJob(data: { task?: unknown }) {
    if (!isFamilyEnabled("maintenance", this.env ?? process.env))
      throw new Error("maintenance family disabled")
    if (data.task !== "daily-maintenance") throw new Error("unknown maintenance task")
    const schedule = FAMILIES.maintenance.schedules[0]
    if (!schedule || !isLegacyReplacementSchedule(schedule))
      throw new Error("maintenance legacy schedule missing")
    await this.gate.runGated(schedule, async () => {
      const summary = await this.db.withTransaction(async (client) => {
        if (!(await this.tryLock(client))) return null
        const result = await client.query<{ summary: unknown }>(
          "SELECT public.run_daily_maintenance() AS summary"
        )
        const summary = result.rows[0]?.summary
        if (summary === null || summary === undefined)
          throw new Error("daily maintenance returned no summary")
        if (typeof summary !== "object")
          throw new Error("daily maintenance summary is not an object")
        return summary
      })
      if (!summary) return "skipped: maintenance already running"
      return JSON.stringify({ ...summary, retention: await this.runRetention() })
    })
  }
  private async tryLock(client: PoolClient) {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS locked",
      [DAILY_MAINTENANCE_LOCK_KEY]
    )
    return lock.rows[0]?.locked === true
  }
  /**
   * Retention runs after the legacy pruning has committed. Each call to
   * private.run_retention gets its own transaction, so a failure keeps the legacy
   * work and row locks last one batch.
   */
  private async runRetention() {
    const totals: RetentionPass = {}
    let databaseSizeBytes = 0
    let passes = 0
    let skipped: string | undefined
    let batchFull = true
    while (batchFull && !skipped && passes < RETENTION_MAX_PASSES) {
      const outcome = await this.db.withTransaction(async (client) => {
        if (!(await this.tryLock(client))) return { skipped: "maintenance already running" }
        const installed = await client.query<{ present: boolean }>(
          "SELECT to_regprocedure('private.run_retention(integer)') IS NOT NULL AS present"
        )
        if (installed.rows[0]?.present !== true) return { skipped: "not installed" }
        const result = await client.query<{ pass: RetentionPass }>(
          "SELECT private.run_retention($1) AS pass",
          [RETENTION_BATCH_SIZE]
        )
        if (!result.rows[0]?.pass) throw new Error("retention returned no summary")
        return { pass: result.rows[0].pass }
      })
      if ("skipped" in outcome) {
        skipped = outcome.skipped
        break
      }
      passes++
      batchFull = false
      for (const [key, value] of Object.entries(outcome.pass)) {
        if (key === "database_size_bytes") databaseSizeBytes = value
        else {
          totals[key] = (totals[key] ?? 0) + value
          if (value >= RETENTION_BATCH_SIZE) batchFull = true
        }
      }
    }
    if (batchFull && !skipped)
      this.logger.warn(
        `retention stopped after ${passes} passes with rows still due; the next run continues`
      )
    if (databaseSizeBytes > DATABASE_SIZE_WARNING_BYTES)
      this.logger.warn(
        `database is ${Math.round(databaseSizeBytes / 1e6)} MB after retention, above the ${DATABASE_SIZE_WARNING_BYTES / 1e6} MB warning threshold`
      )
    return {
      ...totals,
      database_size_bytes: databaseSizeBytes,
      passes,
      drained: !batchFull,
      ...(skipped ? { skipped } : {}),
    }
  }
}
