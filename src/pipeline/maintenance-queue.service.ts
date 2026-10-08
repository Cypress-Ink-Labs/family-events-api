import { Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common"
import { DbService } from "../db/db.service.js"
import { JobsService } from "../jobs/jobs.service.js"
import { CronGateService } from "./cron-gate.service.js"
import { FAMILIES, isLegacyReplacementSchedule } from "./families.js"
import { isFamilyEnabled } from "./flags.js"

export const DAILY_MAINTENANCE_LOCK_KEY = 1_180_030_052

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
    await this.gate.runGated(schedule, () =>
      this.db.withTransaction(async (client) => {
        const lock = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock($1) AS locked",
          [DAILY_MAINTENANCE_LOCK_KEY]
        )
        if (lock.rows[0]?.locked !== true) return "skipped: maintenance already running"
        const result = await client.query<{ summary: unknown }>(
          "SELECT public.run_daily_maintenance() AS summary"
        )
        const summary = result.rows[0]?.summary
        if (summary === null || summary === undefined)
          throw new Error("daily maintenance returned no summary")
        return JSON.stringify(summary)
      })
    )
  }
}
