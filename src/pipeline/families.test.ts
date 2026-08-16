import { describe, expect, it } from "vitest"

import { FAMILIES, JOB_FAMILIES, deadLetterName } from "./families.js"

/**
 * Parity guards in two directions:
 * 1. Against the U12 worker registry in family-events-app src/worker/families.ts
 *    (this file is a verbatim port; drift means one side changed deliberately).
 * 2. Against the legacy Railway cron services every schedule replaces
 *    (family-events-backend infra/railway-cron-drift/cron-services.json) —
 *    db-maintenance intentionally absent (stays on the old pipeline until U18).
 */
const LEGACY_REPLACEMENTS: ReadonlyArray<[service: string, cron: string]> = [
  ["cron-scrape-sources", "0 * * * *"],
  ["cron-cleanup-stale", "*/30 * * * *"],
  ["cron-tag-queue", "*/5 * * * *"],
  ["cron-enrich-events", "*/15 * * * *"],
  ["cron-review-events", "*/5 * * * *"],
  ["cron-weekly-digest", "0 13 * * 1"],
  ["cron-send-reminders", "0 11 * * *"],
]

const allSchedules = JOB_FAMILIES.flatMap((family) => FAMILIES[family].schedules)

describe("FAMILIES", () => {
  it("defines a config with a DLQ for every job family", () => {
    for (const family of JOB_FAMILIES) {
      expect(FAMILIES[family].queue).toBe(family)
      expect(FAMILIES[family].deadLetter).toBe(deadLetterName(family))
    }
  })

  it("replaces every legacy cron service except db-maintenance, exactly once", () => {
    expect(allSchedules.map((schedule) => schedule.replaces).toSorted()).toEqual(
      LEGACY_REPLACEMENTS.map(([service]) => service).toSorted()
    )
  })

  it("preserves each legacy cron expression", () => {
    for (const [service, cron] of LEGACY_REPLACEMENTS) {
      const schedule = allSchedules.find((candidate) => candidate.replaces === service)
      expect(schedule?.cron, service).toBe(cron)
    }
  })

  it("keeps user-facing send families strictly serial", () => {
    expect(FAMILIES.digest.concurrency).toBe(1)
    expect(FAMILIES.reminders.concurrency).toBe(1)
  })

  it("notify is event-driven: no schedules", () => {
    expect(FAMILIES.notify.schedules).toEqual([])
  })

  it("uses unique schedule keys within each queue", () => {
    for (const family of JOB_FAMILIES) {
      const keys = FAMILIES[family].schedules.map((schedule) => schedule.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })
})
