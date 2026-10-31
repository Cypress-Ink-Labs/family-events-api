import { readFileSync } from "node:fs"
import { ensureMaintenanceCatalog } from "./maintenance-catalog.js"
import { ConfigService } from "@nestjs/config"
import { PgBoss } from "pg-boss"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { DbService } from "../../src/db/db.service.js"
import { JobsService } from "../../src/jobs/jobs.service.js"
import { CronGateService } from "../../src/pipeline/cron-gate.service.js"
import {
  MaintenanceQueueService,
  DAILY_MAINTENANCE_LOCK_KEY,
} from "../../src/pipeline/maintenance-queue.service.js"
import { createIntegrationDb, integrationDatabaseUrl } from "./db.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
const retentionForward = readFileSync(
  "schema/migrations/20261030001000_retention_pruning.sql",
  "utf8"
)
const retentionRollback = readFileSync(
  "schema/migrations/20261030001000_retention_pruning_down.sql",
  "utf8"
)

describe("daily maintenance with frozen PostgreSQL behavior", () => {
  let db: DbService
  let worker: MaintenanceQueueService
  beforeAll(async () => {
    db = createIntegrationDb()
    await ensureAdminCatalog(db)
    await ensureMaintenanceCatalog(db)
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    END $$`)
    await db.query("DROP FUNCTION IF EXISTS private.run_retention(integer)")
    await db.query(retentionForward)
    worker = new MaintenanceQueueService({} as JobsService, new CronGateService(db), db, {
      NODE_ENV: "production",
      CUTOVER_MAINTENANCE: "true",
    })
  })
  beforeEach(async () => {
    await truncateAdminCatalog(db)
    await db.query(
      "TRUNCATE public.invite_request_attempts,public.invite_redemption_attempts,public.recommendation_signals"
    )
  })
  afterAll(async () => db.onModuleDestroy())
  async function seedOldAndRetained() {
    const events = await db.query<{ id: string }>(
      "INSERT INTO public.events(title,start_datetime,status) VALUES('Retained event',now(),'published') RETURNING id"
    )
    const { id } = events[0]!
    await db.query(
      "INSERT INTO public.event_tag_queue(event_id,status,finished_at) VALUES($1,'dead',now()-interval '30 days'-interval '5 minutes'),($1,'dead',now()-interval '30 days'+interval '5 minutes'),($1,'failed',now()-interval '7 days'-interval '5 minutes'),($1,'failed',now()-interval '7 days'+interval '5 minutes'),($1,'pending',now()-interval '100 days'),($1,'succeeded',now()-interval '100 days')",
      [id]
    )
    for (const table of ["invite_request_attempts", "invite_redemption_attempts"])
      await db.query(
        `INSERT INTO public.${table}(email_hash,succeeded,attempted_at) VALUES('old-maintenance-fixture',false,now()-interval '30 days'-interval '5 minutes'),('retained-maintenance-fixture',true,now()-interval '30 days'+interval '5 minutes')`
      )
    await db.query(
      "INSERT INTO public.recommendation_signals(created_at) VALUES(now()-interval '90 days'-interval '5 minutes'),(now()-interval '90 days'+interval '5 minutes')"
    )
    await db.query(
      "INSERT INTO public.event_ai_traces(event_id,input_title,created_at) VALUES($1,'Fixture',now()-interval '90 days'-interval '5 minutes'),($1,'Fixture',now()-interval '90 days'+interval '5 minutes')",
      [id]
    )
    await db.query(
      "INSERT INTO public.source_extraction_traces(extraction_mode,extractor,status,created_at) VALUES('deterministic','deterministic','success',now()-interval '90 days'-interval '5 minutes'),('deterministic','deterministic','success',now()-interval '90 days'+interval '5 minutes')"
    )
  }
  async function apiOwns() {
    await db.query(
      "INSERT INTO private.cron_enabled(label,enabled) VALUES('cron-db-maintenance',false)"
    )
  }
  it("keeps invitation attempt fixtures compatible with onboarding and account deletion", async () => {
    for (const table of ["invite_request_attempts", "invite_redemption_attempts"]) {
      await db.query(
        `INSERT INTO public.${table}(email_hash,succeeded) VALUES('maintenance-fixture-hash',false)`
      )
      expect(await db.query(`SELECT email_hash,succeeded FROM public.${table}`)).toEqual([
        { email_hash: "maintenance-fixture-hash", succeeded: false },
      ])
    }
  })
  it("retains all exact legacy pruning families, refreshes timezones and records API history", async () => {
    await seedOldAndRetained()
    await apiOwns()
    await worker.handleJob({ task: "daily-maintenance" })
    const history = await db.query<{
      body: string
      status: string
      http_status: number | null
    }>(
      "SELECT body,status,http_status FROM private.railway_cron_runs WHERE label='cron-db-maintenance'"
    )
    const { body, status, http_status } = history[0]!
    expect(status).toBe("succeeded")
    expect(http_status).toBeNull()
    expect(JSON.parse(body)).toMatchObject({
      event_tag_queue_pruned: 2,
      invite_request_attempts_pruned: 1,
      invite_redemption_attempts_pruned: 1,
      recommendation_signals_pruned: 1,
      ai_traces_pruned: 1,
      extraction_traces_pruned: 1,
      timezone_names_refreshed: true,
    })
    for (const table of [
      "invite_request_attempts",
      "invite_redemption_attempts",
      "recommendation_signals",
    ])
      expect(await db.query(`SELECT count(*)::int AS count FROM public.${table}`)).toEqual([
        { count: 1 },
      ])
    // The 90-day fixtures sit outside the shorter retention windows, so the retention step
    // that follows the legacy function removes the rows the legacy window kept.
    for (const table of ["event_ai_traces", "source_extraction_traces"])
      expect(await db.query(`SELECT count(*)::int AS count FROM public.${table}`)).toEqual([
        { count: 0 },
      ])
    expect(
      await db.query("SELECT status::text FROM public.event_tag_queue ORDER BY finished_at,status")
    ).toEqual([{ status: "pending" }, { status: "dead" }, { status: "failed" }])
    expect(
      await db.query("SELECT name FROM private.timezone_names_cache WHERE name='UTC'")
    ).toEqual([{ name: "UTC" }])
    expect(await db.query("SELECT title FROM public.events")).toEqual([{ title: "Retained event" }])
  })
  it("leaves maintenance with legacy by default, supports a no-writer pause, and rolls ownership back", async () => {
    await seedOldAndRetained()
    await worker.handleJob({ task: "daily-maintenance" })
    await db.query(
      "INSERT INTO private.cron_enabled(label,enabled) VALUES('cron-db-maintenance',false),('nestjs:cron-db-maintenance',false)"
    )
    await worker.handleJob({ task: "daily-maintenance" })
    expect(await db.query("SELECT * FROM private.railway_cron_runs")).toHaveLength(0)
    expect(await db.query("SELECT count(*)::int AS count FROM public.event_tag_queue")).toEqual([
      { count: 6 },
    ])
    await db.query("UPDATE private.cron_enabled SET enabled=true WHERE label='cron-db-maintenance'")
    await worker.handleJob({ task: "daily-maintenance" })
    expect(await db.query("SELECT * FROM private.railway_cron_runs")).toHaveLength(0)
  })
  it("prevents another API process from performing maintenance concurrently", async () => {
    await seedOldAndRetained()
    await apiOwns()
    const lock = await db.pool.connect()
    try {
      await lock.query("BEGIN")
      await lock.query("SELECT pg_advisory_xact_lock($1)", [DAILY_MAINTENANCE_LOCK_KEY])
      await worker.handleJob({ task: "daily-maintenance" })
      expect(await db.query("SELECT count(*)::int AS count FROM public.event_tag_queue")).toEqual([
        { count: 6 },
      ])
      expect(await db.query("SELECT body FROM private.railway_cron_runs")).toEqual([
        { body: "skipped: maintenance already running" },
      ])
    } finally {
      await lock.query("ROLLBACK")
      lock.release()
    }
    await worker.handleJob({ task: "daily-maintenance" })
    expect(await db.query("SELECT count(*)::int AS count FROM public.event_tag_queue")).toEqual([
      { count: 3 },
    ])
  })
  it("rolls every pruning operation back if timezone refresh fails and records failure", async () => {
    await seedOldAndRetained()
    await apiOwns()
    await db.query("DROP INDEX private.timezone_names_cache_name_uidx")
    try {
      await expect(worker.handleJob({ task: "daily-maintenance" })).rejects.toThrow(/concurrently/)
      expect(await db.query("SELECT count(*)::int AS count FROM public.event_tag_queue")).toEqual([
        { count: 6 },
      ])
      for (const table of [
        "invite_request_attempts",
        "invite_redemption_attempts",
        "recommendation_signals",
        "event_ai_traces",
        "source_extraction_traces",
      ])
        expect(await db.query(`SELECT count(*)::int AS count FROM public.${table}`)).toEqual([
          { count: 2 },
        ])
      expect(await db.query("SELECT status FROM private.railway_cron_runs")).toEqual([
        { status: "failed" },
      ])
    } finally {
      await db.query(
        "CREATE UNIQUE INDEX timezone_names_cache_name_uidx ON private.timezone_names_cache(name)"
      )
    }
  })
  it("upserts one 03:15 UTC schedule across runtime boots and removes it on cutover rollback", async () => {
    const schema = "maintenance_queue_fixture"
    const config = new ConfigService({
      NODE_ENV: "development",
      DATABASE_URL: integrationDatabaseUrl(),
      PGBOSS_SCHEMA: schema,
    })
    const inspector = new PgBoss({
      connectionString: integrationDatabaseUrl(),
      schema,
      schedule: false,
      supervise: false,
    })
    await inspector.start()
    try {
      for (let boot = 0; boot < 2; boot++) {
        const jobs = new JobsService(config as never)
        new MaintenanceQueueService(jobs, new CronGateService(db), db, {
          NODE_ENV: "production",
          CUTOVER_MAINTENANCE: "true",
        }).onModuleInit()
        await jobs.onApplicationBootstrap()
        await jobs.onApplicationShutdown()
      }
      expect(await inspector.getSchedules("maintenance")).toMatchObject([
        {
          key: "daily-maintenance",
          cron: "15 3 * * *",
          timezone: "UTC",
          data: { task: "daily-maintenance" },
        },
      ])
      expect(await inspector.getSchedules("maintenance")).toHaveLength(1)
      const rollback = new JobsService(config as never)
      new MaintenanceQueueService(rollback, new CronGateService(db), db, {
        NODE_ENV: "production",
        CUTOVER_MAINTENANCE: "false",
      }).onModuleInit()
      await rollback.onApplicationBootstrap()
      await rollback.onApplicationShutdown()
      expect(await inspector.getSchedules("maintenance")).toEqual([])
    } finally {
      await inspector.stop({ close: true })
    }
  })
  describe("retention", () => {
    const interval = (days: number, offsetMinutes: number) =>
      `now()-interval '${days} days'${offsetMinutes < 0 ? "-" : "+"}interval '${Math.abs(offsetMinutes)} minutes'`
    // 5 minutes outside / inside a window, mirroring the legacy fixtures.
    const outside = (days: number) => interval(days, -5)
    const inside = (days: number) => interval(days, 5)

    async function event(title: string) {
      const rows = await db.query<{ id: string }>(
        "INSERT INTO public.events(title,start_datetime,status) VALUES($1,now(),'published') RETURNING id",
        [title]
      )
      return rows[0]!.id
    }
    async function reviewQueue(eventId: string, status: string, finishedAt: string) {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO public.event_llm_review_queue(event_id,status,finished_at) VALUES($1,$2,${finishedAt}) RETURNING id`,
        [eventId, status]
      )
      return rows[0]!.id
    }
    async function reviewTrace(eventId: string, queueId: string | null, createdAt: string) {
      await db.query(
        `INSERT INTO public.event_llm_review_traces(event_id,queue_id,prompt_version,status,created_at) VALUES($1,$2,'v1','succeeded',${createdAt})`,
        [eventId, queueId]
      )
    }
    const count = async (table: string) =>
      (await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`))[0]!.count

    it("deletes rows just outside each window and keeps rows just inside", async () => {
      const id = await event("Retention event")
      await db.query(
        `INSERT INTO public.event_ai_traces(event_id,input_title,created_at) VALUES($1,'old',${outside(14)}),($1,'kept',${inside(14)})`,
        [id]
      )
      await db.query(
        `INSERT INTO public.source_extraction_traces(extraction_mode,extractor,status,created_at) VALUES('deterministic','deterministic','success',${outside(30)}),('deterministic','deterministic','success',${inside(30)})`
      )
      await reviewTrace(id, null, outside(14))
      await reviewTrace(id, null, inside(14))
      const expired = await event("Expired queue")
      const fresh = await event("Fresh queue")
      const expiredQueue = await reviewQueue(expired, "succeeded", outside(14))
      await reviewQueue(fresh, "succeeded", inside(14))
      await reviewTrace(expired, expiredQueue, inside(1))
      await db.query(
        `INSERT INTO public.event_tag_queue(event_id,status,finished_at) VALUES($1,'succeeded',${outside(14)}),($1,'succeeded',${inside(14)})`,
        [id]
      )
      await db.query(
        `INSERT INTO private.cron_run_log_entries(run_key,label,provider,level,message,created_at) VALUES(gen_random_uuid(),'l','p','info','old',${outside(30)}),(gen_random_uuid(),'l','p','info','kept',${inside(30)})`
      )
      await db.query(
        `INSERT INTO private.railway_cron_runs(label,status,ran_at) VALUES('l','succeeded',${outside(30)}),('l','succeeded',${inside(30)})`
      )

      const { summary } = (
        await db.query<{ summary: Record<string, number> }>(
          "SELECT private.run_retention(100) AS summary"
        )
      )[0]!

      expect(summary).toMatchObject({
        event_ai_traces_pruned: 1,
        event_llm_review_traces_pruned: 2,
        event_llm_review_queue_pruned: 1,
        event_tag_queue_succeeded_pruned: 1,
        source_extraction_traces_pruned: 1,
        cron_run_log_entries_pruned: 1,
        railway_cron_runs_pruned: 1,
      })
      expect(summary.database_size_bytes).toBeGreaterThan(0)
      expect(await db.query("SELECT input_title FROM public.event_ai_traces")).toEqual([
        { input_title: "kept" },
      ])
      expect(await db.query("SELECT message FROM private.cron_run_log_entries")).toEqual([
        { message: "kept" },
      ])
      expect(await count("public.source_extraction_traces")).toBe(1)
      expect(await count("public.event_llm_review_traces")).toBe(1)
      expect(await db.query("SELECT event_id FROM public.event_llm_review_queue")).toEqual([
        { event_id: fresh },
      ])
      expect(await count("public.event_tag_queue")).toBe(1)
      expect(await count("private.railway_cron_runs")).toBe(1)
    })

    it("never deletes non-terminal queue rows at any age and leaves legacy tag rules to the legacy function", async () => {
      const queued: string[] = []
      for (const status of ["pending", "processing", "retrying"]) {
        const id = await event(`Active ${status}`)
        queued.push(await reviewQueue(id, status, outside(100)))
        await db.query(
          `UPDATE public.event_llm_review_queue SET created_at=${outside(100)} WHERE id=$1`,
          [queued.at(-1)]
        )
      }
      for (const status of ["pending", "processing"]) {
        const id = await event(`Tag ${status}`)
        await db.query(
          `INSERT INTO public.event_tag_queue(event_id,status,finished_at) VALUES($1,$2,${outside(100)})`,
          [id, status]
        )
      }
      const id = await event("Tag terminal")
      await db.query(
        `INSERT INTO public.event_tag_queue(event_id,status,finished_at) VALUES($1,'dead',${outside(14)}),($1,'failed',${outside(14)})`,
        [id]
      )
      await reviewTrace(await event("Old trace of active"), queued[0]!, outside(14))
      await db.query("SELECT private.run_retention(100)")
      expect(
        await db.query("SELECT status::text FROM public.event_llm_review_queue ORDER BY id")
      ).toEqual([{ status: "pending" }, { status: "processing" }, { status: "retrying" }])
      expect(
        await db.query("SELECT status::text FROM public.event_tag_queue ORDER BY status")
      ).toEqual([
        { status: "dead" },
        { status: "failed" },
        { status: "pending" },
        { status: "processing" },
      ])
      expect(await count("public.event_llm_review_traces")).toBe(0)
    })

    it("deletes at most one batch per table per call and keeps queue rows until their traces are gone", async () => {
      const id = await event("Batch event")
      await db.query(
        `INSERT INTO public.event_ai_traces(event_id,input_title,created_at) SELECT $1,'old',${outside(14)} FROM generate_series(1,5)`,
        [id]
      )
      const queueId = await reviewQueue(id, "succeeded", outside(14))
      for (let n = 0; n < 3; n++) await reviewTrace(id, queueId, inside(1))
      const call = async () =>
        (
          await db.query<{ summary: Record<string, number> }>(
            "SELECT private.run_retention(2) AS summary"
          )
        )[0]!.summary
      expect(await call()).toMatchObject({
        event_ai_traces_pruned: 2,
        event_llm_review_traces_pruned: 2,
        event_llm_review_queue_pruned: 0,
      })
      expect(await call()).toMatchObject({
        event_ai_traces_pruned: 2,
        event_llm_review_traces_pruned: 1,
        event_llm_review_queue_pruned: 1,
      })
      expect(await call()).toMatchObject({ event_ai_traces_pruned: 1 })
      expect(await count("public.event_ai_traces")).toBe(0)
      expect(await count("public.event_llm_review_queue")).toBe(0)
    })

    it("rejects a non-positive batch size", async () => {
      await expect(db.query("SELECT private.run_retention(0)")).rejects.toThrow(/batch size/)
    })

    it("reports per-table totals and the database size in the maintenance summary, repeating until drained", async () => {
      await apiOwns()
      const id = await event("Worker event")
      await db.query(
        `INSERT INTO public.event_ai_traces(event_id,input_title,created_at) SELECT $1,'old',${outside(14)} FROM generate_series(1,5001)`,
        [id]
      )
      await worker.handleJob({ task: "daily-maintenance" })
      const history = await db.query<{ body: string }>(
        "SELECT body FROM private.railway_cron_runs WHERE label='cron-db-maintenance'"
      )
      const { retention } = JSON.parse(history[0]!.body)
      expect(retention).toMatchObject({
        event_ai_traces_pruned: 5001,
        event_tag_queue_succeeded_pruned: 0,
        passes: 2,
      })
      expect(retention.database_size_bytes).toBeGreaterThan(0)
      expect(await count("public.event_ai_traces")).toBe(0)
    })

    it("skips retention without failing when the migration is not applied", async () => {
      await apiOwns()
      await db.query(retentionRollback)
      try {
        await worker.handleJob({ task: "daily-maintenance" })
        const history = await db.query<{ body: string }>(
          "SELECT body FROM private.railway_cron_runs WHERE label='cron-db-maintenance'"
        )
        expect(JSON.parse(history[0]!.body).retention).toMatch(/not installed/)
      } finally {
        await db.query(retentionForward)
      }
    })

    it("keeps the legacy pruning when retention fails and surfaces the failure", async () => {
      await seedOldAndRetained()
      await apiOwns()
      await db.query(
        "CREATE OR REPLACE FUNCTION private.run_retention(p_batch_size integer) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retention boom'; END $$"
      )
      try {
        await expect(worker.handleJob({ task: "daily-maintenance" })).rejects.toThrow(
          /retention boom/
        )
        expect(await count("public.event_tag_queue")).toBe(4)
        expect(await db.query("SELECT status FROM private.railway_cron_runs")).toEqual([
          { status: "failed" },
        ])
      } finally {
        await db.query(retentionForward.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"))
      }
    })

    it("removes the retention step when the migration is rolled back", async () => {
      const present = () =>
        db.query<{ present: boolean }>(
          "SELECT to_regprocedure('private.run_retention(integer)') IS NOT NULL AS present"
        )
      expect(await present()).toEqual([{ present: true }])
      await db.query(retentionRollback)
      try {
        expect(await present()).toEqual([{ present: false }])
      } finally {
        await db.query(retentionForward)
      }
    })
  })
})
