import { Injectable, Logger } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { PipelineSchedule } from "./schedules.js"

/**
 * Kill-switch and run-history parity with the legacy Railway cron runner (U27).
 *
 * - Gate: private.cron_enabled, keyed by the LEGACY label so the existing admin
 *   UI toggles keep working through cutover. A missing row means enabled
 *   (COALESCE(..., true) — same as private.is_cron_enabled).
 * - History: private.railway_cron_runs, same table the admin drill-down reads.
 *   http_status stays NULL: there is no HTTP hop anymore, the worker runs in-process.
 */
@Injectable()
export class CronGateService {
  private readonly logger = new Logger(CronGateService.name)

  constructor(private readonly db: DbService) {}

  async isEnabled(legacyLabel: string): Promise<boolean> {
    const rows = await this.db.query<{ enabled: boolean }>(
      "SELECT COALESCE((SELECT enabled FROM private.cron_enabled WHERE label = $1), true) AS enabled",
      [legacyLabel]
    )
    return rows[0]?.enabled ?? true
  }

  async recordRun(
    legacyLabel: string,
    status: "succeeded" | "failed",
    durationS: number,
    body: string | null
  ): Promise<void> {
    await this.db.query(
      "INSERT INTO private.railway_cron_runs (label, status, duration_s, body) VALUES ($1, $2, $3, $4)",
      [legacyLabel, status, Math.max(0, Math.round(durationS)), body]
    )
  }

  /**
   * Run one scheduled tick with legacy runner semantics:
   * skip silently when the kill switch is off; otherwise time the run,
   * record the outcome, and rethrow failures so pg-boss retry policy applies.
   */
  async runGated(schedule: PipelineSchedule, fn: () => Promise<string | void>): Promise<void> {
    if (!(await this.isEnabled(schedule.legacyLabel))) {
      this.logger.log(`${schedule.legacyLabel} disabled by kill switch; skipping tick`)
      return
    }
    const startedAtMs = Date.now()
    try {
      const summary = await fn()
      await this.recordRun(
        schedule.legacyLabel,
        "succeeded",
        (Date.now() - startedAtMs) / 1000,
        summary ?? null
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.recordRun(
        schedule.legacyLabel,
        "failed",
        (Date.now() - startedAtMs) / 1000,
        message
      )
      throw error
    }
  }
}
