import { ConfigService } from "@nestjs/config"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { DbService } from "../../src/db/db.service.js"
import { CronGateService } from "../../src/pipeline/cron-gate.service.js"
import { PIPELINE_SCHEDULES } from "../../src/pipeline/schedules.js"

/**
 * Runs against a real Postgres (DATABASE_URL). Creates the same private-schema
 * objects the legacy migrations define, scoped to this test database.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres"

const SCHEDULE = PIPELINE_SCHEDULES.find((s) => s.queue === "scrape-sources")!

describe("CronGateService (integration)", () => {
  let db: DbService
  let gate: CronGateService

  beforeAll(async () => {
    db = new DbService(new ConfigService({ DATABASE_URL }) as unknown as ConfigService<never, true>)
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

  it("missing row means enabled; explicit false disables", async () => {
    expect(await gate.isEnabled(SCHEDULE.legacyLabel)).toBe(true)
    await db.query("INSERT INTO private.cron_enabled (label, enabled) VALUES ($1, false)", [
      SCHEDULE.legacyLabel,
    ])
    expect(await gate.isEnabled(SCHEDULE.legacyLabel)).toBe(false)
  })

  it("successful gated run lands in railway_cron_runs with succeeded status", async () => {
    await gate.runGated(SCHEDULE, async () => "ok: 3 sources due")
    const runs = await db.query<{ label: string; status: string; body: string | null }>(
      "SELECT label, status, body FROM private.railway_cron_runs"
    )
    expect(runs).toEqual([
      { label: SCHEDULE.legacyLabel, status: "succeeded", body: "ok: 3 sources due" },
    ])
  })

  it("failed gated run records failure and rethrows", async () => {
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

  it("disabled label runs nothing and records nothing", async () => {
    await db.query("INSERT INTO private.cron_enabled (label, enabled) VALUES ($1, false)", [
      SCHEDULE.legacyLabel,
    ])
    let executed = false
    await gate.runGated(SCHEDULE, async () => {
      executed = true
    })
    expect(executed).toBe(false)
    const runs = await db.query("SELECT 1 FROM private.railway_cron_runs")
    expect(runs).toHaveLength(0)
  })

  it("timestamptz round-trips as text per the U6 convention", async () => {
    const rows = await db.query<{ now: string }>("SELECT now() AS now")
    expect(typeof rows[0]?.now).toBe("string")
  })
})
