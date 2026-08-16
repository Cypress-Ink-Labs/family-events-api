import { describe, expect, it } from "vitest"

import { PIPELINE_SCHEDULES } from "./schedules.js"

/**
 * Parity guard against the legacy Railway cron topology
 * (family-events-backend .railway/railway.ts + config/deploy.config.json).
 * If the legacy schedules change before cutover, update both this table
 * and schedules.ts deliberately.
 */
const LEGACY_TOPOLOGY: ReadonlyArray<[label: string, edgeFunction: string, cron: string]> = [
  ["cron-scrape-sources", "scrape-due-sources", "0 * * * *"],
  ["cron-tag-queue", "process-tag-queue", "*/5 * * * *"],
  ["cron-review-events", "process-event-review-queue", "*/5 * * * *"],
  ["cron-enrich-events", "backfill-event-enrichment", "*/15 * * * *"],
  ["cron-cleanup-stale", "cleanup-stale-runs", "*/30 * * * *"],
  ["cron-db-maintenance", "db-maintenance", "15 3 * * *"],
  ["cron-send-reminders", "send-reminders", "0 11 * * *"],
  ["cron-weekly-digest", "send-weekly-digest", "0 13 * * 1"],
]

describe("PIPELINE_SCHEDULES", () => {
  it("covers every legacy cron service exactly once", () => {
    expect(PIPELINE_SCHEDULES.map((schedule) => schedule.legacyLabel).toSorted()).toEqual(
      LEGACY_TOPOLOGY.map(([label]) => label).toSorted()
    )
  })

  it("preserves each legacy schedule and edge-function mapping", () => {
    for (const [label, edgeFunction, cron] of LEGACY_TOPOLOGY) {
      const schedule = PIPELINE_SCHEDULES.find((candidate) => candidate.legacyLabel === label)
      expect(schedule, label).toBeDefined()
      expect(schedule?.replacesEdgeFunction, label).toBe(edgeFunction)
      expect(schedule?.cron, label).toBe(cron)
    }
  })

  it("never retries user-facing sends (reminders, digest)", () => {
    for (const schedule of PIPELINE_SCHEDULES) {
      const isUserFacingSend =
        schedule.queue === "send-reminders" || schedule.queue === "send-weekly-digest"
      expect(schedule.retryLimit, schedule.queue).toBe(isUserFacingSend ? 0 : 1)
    }
  })

  it("uses unique queue names", () => {
    const names = PIPELINE_SCHEDULES.map((schedule) => schedule.queue)
    expect(new Set(names).size).toBe(names.length)
  })
})
