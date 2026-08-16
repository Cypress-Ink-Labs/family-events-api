import { Injectable, Logger } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { FamilySchedule } from "./families.js"

/**
 * Kill-switch and run-history parity with the legacy Railway cron runner (U27).
 *
 * - Gate: private.cron_enabled, keyed by the LEGACY service label a schedule
 *   replaces, so the existing admin UI toggles keep working through cutover.
 *   A missing row means enabled (COALESCE(..., true) — same as
 *   private.is_cron_enabled).
 * - History: private.railway_cron_runs, same table the admin drill-down reads.
 *   http_status stays NULL: there is no HTTP hop anymore, the worker runs
 *   in-process.
 *
 * Only scheduled (cron-replacing) work is gated; event-driven jobs like the
 * notify family have no legacy label and no kill switch.
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
  async runGated(schedule: FamilySchedule, fn: () => Promise<string | void>): Promise<void> {
    if (!(await this.isEnabled(schedule.replaces))) {
      this.logger.log(`${schedule.replaces} disabled by kill switch; skipping ${schedule.key}`)
      return
    }
    const startedAtMs = Date.now()
    try {
      const summary = await fn()
      await this.recordRun(
        schedule.replaces,
        "succeeded",
        (Date.now() - startedAtMs) / 1000,
        summary ?? null
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.recordRun(schedule.replaces, "failed", (Date.now() - startedAtMs) / 1000, message)
      throw error
    }
  }
}
