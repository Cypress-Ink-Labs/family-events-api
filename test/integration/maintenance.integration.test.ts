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
describe("daily maintenance with frozen PostgreSQL behavior", () => {
  let db: DbService
  let worker: MaintenanceQueueService
  beforeAll(async () => {
    db = createIntegrationDb()
    await ensureAdminCatalog(db)
    await ensureMaintenanceCatalog(db)
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
      "event_ai_traces",
      "source_extraction_traces",
    ])
      expect(await db.query(`SELECT count(*)::int AS count FROM public.${table}`)).toEqual([
        { count: 1 },
      ])
    expect(
      await db.query("SELECT status::text FROM public.event_tag_queue ORDER BY finished_at,status")
    ).toEqual([
      { status: "pending" },
      { status: "succeeded" },
      { status: "dead" },
      { status: "failed" },
    ])
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
      { count: 4 },
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
})
