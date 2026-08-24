import { Injectable, Logger, Optional } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { FamilySchedule } from "./families.js"
import { FailurePingService } from "./failure-ping.service.js"

export interface CronGateState {
  legacyEnabled: boolean
  nestEnabled: boolean
}

export function nestGateLabel(legacyLabel: string): string {
  return `nestjs:${legacyLabel}`
}

/**
 * Atomic ownership handoff and run-history parity with the legacy Railway
 * cron runner (U27/U33).
 *
 * - Handoff gate: private.cron_enabled is the LEGACY owner's enable bit,
 *   keyed by the Railway service label a schedule replaces. A missing row
 *   means legacy-enabled. Nest therefore waits while it is true and begins
 *   only after the same atomic database update disables the legacy owner.
 * - Operational gate: `nestjs:<legacy label>` independently controls Nest.
 *   Missing means enabled. Nest runs only when legacy=false AND Nest=true,
 *   which permits a no-writer pause and an ordered rollback without dual
 *   writers while the registered worker continues consuming scheduled jobs.
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

  constructor(
    private readonly db: DbService,
    @Optional() private readonly failurePing?: FailurePingService
  ) {}

  async getGateState(legacyLabel: string): Promise<CronGateState> {
    const rows = await this.db.query<CronGateState>(
      `SELECT
         COALESCE((SELECT enabled FROM private.cron_enabled WHERE label = $1), true)
           AS "legacyEnabled",
         COALESCE((SELECT enabled FROM private.cron_enabled WHERE label = $2), true)
           AS "nestEnabled"`,
      [legacyLabel, nestGateLabel(legacyLabel)]
    )
    return rows[0] ?? { legacyEnabled: true, nestEnabled: true }
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
   * Run one scheduled Nest tick only after the legacy owner is disabled.
   * Successful/failed Nest executions retain the legacy run-history label,
   * and failures rethrow so pg-boss retry policy applies.
   */
  async runGated(schedule: FamilySchedule, fn: () => Promise<string | void>): Promise<void> {
    const state = await this.getGateState(schedule.replaces)
    if (state.legacyEnabled) {
      this.logger.log(`${schedule.replaces} still owns schedule; skipping Nest ${schedule.key}`)
      return
    }
    if (!state.nestEnabled) {
      this.logger.log(`${nestGateLabel(schedule.replaces)} paused; skipping Nest ${schedule.key}`)
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
      await this.failurePing
        ?.send({ functionName: schedule.replaces, kind: "function_failed", error: message })
        .catch((pingError: unknown) => {
          this.logger.warn(`failure ping threw: ${String(pingError)}`)
        })
      throw error
    }
  }
}
