import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { DbService } from "../../src/db/db.service.js"
import { createIntegrationDb } from "./db.js"
import { CronGateService, nestGateLabel } from "../../src/pipeline/cron-gate.service.js"
import { FAMILIES, isLegacyReplacementSchedule } from "../../src/pipeline/families.js"

/**
 * Runs against a real Postgres (DATABASE_URL). Creates the same private-schema
 * objects the legacy migrations define, scoped to this test database.
 */
const scheduleCandidate = FAMILIES.scrape.schedules[0]
if (!scheduleCandidate || !isLegacyReplacementSchedule(scheduleCandidate)) {
  throw new Error("scrape legacy schedule fixture missing")
}
const SCHEDULE = scheduleCandidate

describe("CronGateService (integration)", () => {
  let db: DbService
  let gate: CronGateService

  beforeAll(async () => {
    db = createIntegrationDb()
    await db.query("CREATE SCHEMA IF NOT EXISTS private")
    await db.query(`CREATE TABLE IF NOT EXISTS private.cron_enabled (
      label text PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)
    await db.query(`CREATE TABLE IF NOT EXISTS private.railway_cron_runs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      label text NOT NULL,
      status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
      http_status integer,
      duration_s integer,
      body text,
      ran_at timestamptz NOT NULL DEFAULT now()
    )`)
    gate = new CronGateService(db)
  })

  beforeEach(async () => {
    await db.query("TRUNCATE private.cron_enabled, private.railway_cron_runs")
  })

  afterAll(async () => {
    await db.onModuleDestroy()
  })

  it("missing row means legacy-enabled; explicit false hands ownership to Nest", async () => {
    expect(await gate.getGateState(SCHEDULE.replaces)).toEqual({
      legacyEnabled: true,
      nestEnabled: true,
    })
    await db.query("INSERT INTO private.cron_enabled (label, enabled) VALUES ($1, false)", [
      SCHEDULE.replaces,
    ])
    expect(await gate.getGateState(SCHEDULE.replaces)).toEqual({
      legacyEnabled: false,
      nestEnabled: true,
    })
  })

  it("successful gated run lands in railway_cron_runs with succeeded status", async () => {
    await db.query("INSERT INTO private.cron_enabled (label, enabled) VALUES ($1, false)", [
      SCHEDULE.replaces,
    ])
    await gate.runGated(SCHEDULE, async () => "ok: 3 sources due")
    const runs = await db.query<{ label: string; status: string; body: string | null }>(
      "SELECT label, status, body FROM private.railway_cron_runs"
    )
    expect(runs).toEqual([
      { label: SCHEDULE.replaces, status: "succeeded", body: "ok: 3 sources due" },
    ])
  })

  it("failed gated run records failure and rethrows", async () => {
    await db.query("INSERT INTO private.cron_enabled (label, enabled) VALUES ($1, false)", [
      SCHEDULE.replaces,
    ])
    await expect(
      gate.runGated(SCHEDULE, async () => {
        throw new Error("upstream 500")
      })
    ).rejects.toThrow("upstream 500")
    const runs = await db.query<{ status: string; body: string | null }>(
      "SELECT status, body FROM private.railway_cron_runs"
    )
    expect(runs).toEqual([{ status: "failed", body: "upstream 500" }])
  })

  it("legacy-enabled label runs no Nest work and records nothing", async () => {
    await db.query("INSERT INTO private.cron_enabled (label, enabled) VALUES ($1, true)", [
      SCHEDULE.replaces,
    ])
    let executed = false
    await gate.runGated(SCHEDULE, async () => {
      executed = true
    })
    expect(executed).toBe(false)
    const runs = await db.query("SELECT 1 FROM private.railway_cron_runs")
    expect(runs).toHaveLength(0)
  })

  it("namespaced Nest label pauses execution without re-enabling legacy", async () => {
    await db.query(
      "INSERT INTO private.cron_enabled (label, enabled) VALUES ($1, false), ($2, false)",
      [SCHEDULE.replaces, nestGateLabel(SCHEDULE.replaces)]
    )
    let executed = false
    await gate.runGated(SCHEDULE, async () => {
      executed = true
    })
    expect(executed).toBe(false)
    expect(await gate.getGateState(SCHEDULE.replaces)).toEqual({
      legacyEnabled: false,
      nestEnabled: false,
    })
    const runs = await db.query("SELECT 1 FROM private.railway_cron_runs")
    expect(runs).toHaveLength(0)
  })

  it("timestamptz round-trips as text per the U6 convention", async () => {
    const rows = await db.query<{ now: string }>("SELECT now() AS now")
    expect(typeof rows[0]?.now).toBe("string")
  })
})
