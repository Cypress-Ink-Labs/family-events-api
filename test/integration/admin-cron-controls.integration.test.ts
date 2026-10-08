import { verifyToken } from "@clerk/backend"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { PgBoss } from "pg-boss"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { AdminModule } from "../../src/admin/admin.module.js"
import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { ensureMaintenanceCatalog } from "./maintenance-catalog.js"
import { MaintenanceQueueService } from "../../src/pipeline/maintenance-queue.service.js"
import { JobsService } from "../../src/jobs/jobs.service.js"
import { CronGateService } from "../../src/pipeline/cron-gate.service.js"
import { ScrapeQueueService } from "../../src/pipeline/ingestion/scrape-queue.service.js"
import { IngestionRepository } from "../../src/pipeline/ingestion/ingestion.repository.js"
import type { FailurePingService } from "../../src/pipeline/failure-ping.service.js"
import { NotifyQueueService } from "../../src/notifications/notify-queue.service.js"
import type { NotificationQueueService } from "../../src/notifications/notification-queue.service.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { integrationDatabaseUrl } from "./db.js"

vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }))
const ADMIN = "11111111-1111-4111-8111-111111111111"
const MEMBER = "22222222-2222-4222-8222-222222222222"
const LABEL = "cron-scrape-sources"

describe("operator schedule controls over HTTP and disposable pg-boss", () => {
  let app: INestApplication
  let db: DbService
  let boss: PgBoss
  beforeAll(async () => {
    boss = new PgBoss({
      connectionString: integrationDatabaseUrl(),
      schema: "cron_controls_fixture",
      schedule: false,
      supervise: false,
    })
    await boss.start()
    await boss.createQueue("scrape")
    await boss.createQueue("notify")
    await boss.createQueue("maintenance")
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              DATABASE_URL: integrationDatabaseUrl(),
              CLERK_SECRET_KEY: "sk_test_fixture",
              NODE_ENV: "test",
              PGBOSS_SCHEMA: "cron_controls_fixture",
            }),
          ],
        }),
        DbModule,
        AdminModule,
      ],
    })
      .overrideProvider(JobsService)
      .useValue({
        send: (name: string, data: object, options: object) => boss.send(name, data, options),
      })
      .compile()
    app = module.createNestApplication()
    await app.init()
    db = app.get(DbService)
    await ensureAdminCatalog(db)
    await ensureMaintenanceCatalog(db)
    await db.query(
      `CREATE TABLE IF NOT EXISTS public.clerk_user_mapping(clerk_user_id text PRIMARY KEY, supabase_uuid uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE, email text NOT NULL, role text NOT NULL)`
    )
  })
  beforeEach(async () => {
    vi.unstubAllEnvs()
    await truncateAdminCatalog(db)
    await db.query("TRUNCATE public.clerk_user_mapping CASCADE")
    await db.query("TRUNCATE cron_controls_fixture.job CASCADE")
    await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [ADMIN, MEMBER])
    await db.query("INSERT INTO public.user_profiles(id,role) VALUES($1,'admin'),($2,'user')", [
      ADMIN,
      MEMBER,
    ])
    await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES($1,true),($2,true)", [
      ADMIN,
      MEMBER,
    ])
    await db.query(
      "INSERT INTO public.clerk_user_mapping(clerk_user_id,supabase_uuid,email,role) VALUES('user_operator',$1,'operator@example.test','operator'),('user_member',$2,'member@example.test','member')",
      [ADMIN, MEMBER]
    )
    vi.mocked(verifyToken).mockImplementation(async (token) => {
      if (token === "operator" || token === "member")
        return { sub: `user_${token}` } as Awaited<ReturnType<typeof verifyToken>>
      throw new Error("invalid fixture token")
    })
  })
  it("cannot dispatch or hand ownership to an API family disabled in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("CUTOVER_SCRAPE", "false")
    await owner("api").expect(409)
    await db.query("INSERT INTO private.cron_enabled(label,enabled) VALUES($1,false)", [LABEL])
    await post().expect(409)
    expect(await db.query("SELECT * FROM cron_controls_fixture.job")).toHaveLength(0)
    await owner("paused").expect(200)
  })
  it("processes a due sweep through the actual gated worker and exposes history and detail", async () => {
    await owner("api").expect(200)
    await post().expect(202)
    const [job] = await boss.fetch<{ task: string }>("scrape")
    const worker = new ScrapeQueueService(
      {
        send: (name: string, data: object, options: object) => boss.send(name, data, options),
      } as JobsService,
      new CronGateService(db),
      new IngestionRepository(db),
      {} as FailurePingService
    )
    await worker.handleJob(job!.data)
    const history = await request(app.getHttpServer())
      .get(`/v1/admin/crons/runs?label=${LABEL}`)
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(history.body.items).toHaveLength(1)
    expect(history.body.items[0]).toMatchObject({
      label: LABEL,
      status: "succeeded",
      http_status: null,
    })
    const detail = await request(app.getHttpServer())
      .get(`/v1/admin/crons/runs/${history.body.items[0].id}`)
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(detail.body).toMatchObject({ body: "dispatched", run_key: expect.any(String), logs: [] })
  })
  it("rechecks pause after dispatch before a queued worker can perform work", async () => {
    await owner("api").expect(200)
    await post().expect(202)
    await owner("paused").expect(200)
    const [job] = await boss.fetch<{ task: string }>("scrape")
    const worker = new ScrapeQueueService(
      {} as JobsService,
      new CronGateService(db),
      new IngestionRepository(db),
      {} as FailurePingService
    )
    await worker.handleJob(job!.data)
    expect(await db.query("SELECT * FROM private.railway_cron_runs")).toHaveLength(0)
  })
  it("blocks rollback while API jobs are active, then permits legacy ownership after settlement", async () => {
    await owner("api").expect(200)
    await post().expect(202)
    const [job] = await boss.fetch("scrape")
    await owner("legacy").expect(409)
    expect(
      await db.query("SELECT enabled FROM private.cron_enabled WHERE label=$1", [LABEL])
    ).toEqual([{ enabled: false }])
    await boss.complete("scrape", job!.id)
    await owner("legacy").expect(200)
  })
  it("gates the internal worker and records its real in-process history", async () => {
    const processRun = vi.fn(async () => ({
      ok: true,
      lockAcquired: true,
      skipped: false,
      processed: 0,
      refreshed: 0,
      persistenceFailed: false,
      channels: {
        email: { sent: 0, failed: 0, skipped: 0 },
        inApp: { sent: 0, failed: 0, skipped: 0 },
        push: { sent: 0, failed: 0, skipped: 0, pruned: 0, unmatchedRecipients: 0 },
      },
    }))
    const worker = new NotifyQueueService(
      {} as JobsService,
      { processRun } as unknown as NotificationQueueService,
      new CronGateService(db),
      { NODE_ENV: "production", CUTOVER_NOTIFY: "true" }
    )
    const label = "cron-process-notification-queue"
    await owner("paused", label).expect(200)
    await worker.handleJob({ task: "process" })
    expect(processRun).not.toHaveBeenCalled()
    await owner("api", label).expect(200)
    await worker.handleJob({ task: "process" })
    expect(processRun).toHaveBeenCalledOnce()
    expect(
      await db.query("SELECT label,status,http_status FROM private.railway_cron_runs")
    ).toEqual([{ label, status: "succeeded", http_status: null }])
  })
  it("rolls back both ownership bits if the second write fails", async () => {
    await db.query(
      `CREATE OR REPLACE FUNCTION private.reject_cron_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.label LIKE 'nestjs:%' THEN RAISE EXCEPTION 'controlled cron rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_cron_fixture BEFORE INSERT ON private.cron_enabled FOR EACH ROW EXECUTE FUNCTION private.reject_cron_fixture()`
    )
    try {
      await owner("api").expect(500)
      expect(await db.query("SELECT * FROM private.cron_enabled")).toHaveLength(0)
      expect(await db.query("SELECT * FROM public.admin_audit_log")).toHaveLength(0)
    } finally {
      await db.query(
        "DROP TRIGGER reject_cron_fixture ON private.cron_enabled; DROP FUNCTION private.reject_cron_fixture()"
      )
    }
  })
  it("rolls back queue insertion if the mapped dispatch audit cannot persist", async () => {
    await owner("api").expect(200)
    await db.query(
      `CREATE OR REPLACE FUNCTION private.reject_run_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='cron.run' THEN RAISE EXCEPTION 'controlled dispatch rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_run_audit_fixture BEFORE INSERT ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION private.reject_run_audit_fixture()`
    )
    try {
      await post().expect(500)
      expect(await db.query("SELECT * FROM cron_controls_fixture.job")).toHaveLength(0)
    } finally {
      await db.query(
        "DROP TRIGGER reject_run_audit_fixture ON public.admin_audit_log; DROP FUNCTION private.reject_run_audit_fixture()"
      )
    }
  })
  afterAll(async () => {
    await app.close()
    await boss.stop({ close: true })
  })
  function post(label = LABEL) {
    return request(app.getHttpServer())
      .post(`/v1/admin/crons/${label}/run`)
      .set("Authorization", "Bearer operator")
      .send({})
  }
  function owner(value: string, label = LABEL) {
    return request(app.getHttpServer())
      .put(`/v1/admin/crons/${label}/owner`)
      .set("Authorization", "Bearer operator")
      .send({ owner: value })
  }

  it("atomically transfers, pauses and rolls back a configured owner with mapped audit identity", async () => {
    await owner("api").expect(200)
    expect(await db.query("SELECT label,enabled FROM private.cron_enabled ORDER BY label")).toEqual(
      [
        { label: LABEL, enabled: false },
        { label: `nestjs:${LABEL}`, enabled: true },
      ]
    )
    await owner("paused").expect(200)
    await post().expect(409)
    await owner("legacy").expect(200)
    expect(await db.query("SELECT label,enabled FROM private.cron_enabled ORDER BY label")).toEqual(
      [
        { label: LABEL, enabled: true },
        { label: `nestjs:${LABEL}`, enabled: false },
      ]
    )
    const audit = await db.query<{ admin_user_id: string }>(
      "SELECT admin_user_id FROM public.admin_audit_log WHERE action='cron.owner'"
    )
    expect(audit).toHaveLength(3)
    expect(audit.every((row) => row.admin_user_id === ADMIN)).toBe(true)
  })
  it("queues the real due-scrape task once and returns a queue receipt rather than completion", async () => {
    await post().expect(409)
    await owner("api").expect(200)
    const receipt = await post().expect(202)
    expect(receipt.body).toMatchObject({ label: LABEL, accepted: true, job_id: expect.any(String) })
    const duplicate = await post().expect(202)
    expect(duplicate.body).toMatchObject({ accepted: false, job_id: null })
    expect(
      await db.query("SELECT name,data FROM cron_controls_fixture.job WHERE name='scrape'")
    ).toEqual([{ name: "scrape", data: { task: "scrape-due-sources" } }])
  })
  it("queues daily maintenance through HTTP and exposes the completed retained operation in history", async () => {
    const label = "cron-db-maintenance"
    await owner("api", label).expect(200)
    await db.query("TRUNCATE public.invite_request_attempts")
    await db.query(
      "INSERT INTO public.invite_request_attempts(attempted_at) VALUES(now()-interval '31 days')"
    )
    await post(label).expect(202)
    const [job] = await boss.fetch<{ task: string }>("maintenance")
    expect(job!.data).toEqual({ task: "daily-maintenance" })
    await new MaintenanceQueueService({} as JobsService, new CronGateService(db), db, {
      NODE_ENV: "production",
      CUTOVER_MAINTENANCE: "true",
    }).handleJob(job!.data)
    const history = await request(app.getHttpServer())
      .get(`/v1/admin/crons/runs?label=${label}`)
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(history.body.items[0]).toMatchObject({ label, status: "succeeded", http_status: null })
    const detail = await request(app.getHttpServer())
      .get(`/v1/admin/crons/runs/${history.body.items[0].id}`)
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(JSON.parse(detail.body.body)).toMatchObject({
      invite_request_attempts_pruned: 1,
      timezone_names_refreshed: true,
    })
    const schedules = await request(app.getHttpServer())
      .get("/v1/admin/crons")
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(
      schedules.body.items.find((item: { label: string }) => item.label === label)
    ).toMatchObject({ cron: "15 3 * * *", timezone: "UTC", owner: "api", effective_enabled: true })
  })
  it("protects owner mutations and run dispatch before writes", async () => {
    for (const token of [null, "invalid", "member"]) {
      const operation = request(app.getHttpServer())
        .put(`/v1/admin/crons/${LABEL}/owner`)
        .send({ owner: "api" })
      if (token) operation.set("Authorization", `Bearer ${token}`)
      await operation.expect(token === "member" ? 404 : 401)
    }
    await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [ADMIN])
    await owner("api").expect(403)
    await post().expect(403)
    expect(await db.query("SELECT * FROM private.cron_enabled")).toHaveLength(0)
    expect(await db.query("SELECT * FROM cron_controls_fixture.job")).toHaveLength(0)
  })
  it("denies a mapped operator without a database admin role", async () => {
    await db.query("UPDATE public.user_profiles SET role='user' WHERE id=$1", [ADMIN])
    await owner("api").expect(403)
    await post().expect(403)
  })
  it("rejects unknown labels, actor selectors and malformed bodies", async () => {
    await owner("api", "unknown").expect(400)
    await owner("invalid").expect(400)
    await request(app.getHttpServer())
      .put(`/v1/admin/crons/${LABEL}/owner`)
      .set("Authorization", "Bearer operator")
      .send({ owner: "api", actor: MEMBER })
      .expect(400)
    await request(app.getHttpServer())
      .post(`/v1/admin/crons/${LABEL}/run?actor=${MEMBER}`)
      .set("Authorization", "Bearer operator")
      .send({})
      .expect(400)
    expect(await db.query("SELECT * FROM cron_controls_fixture.job")).toHaveLength(0)
  })
  it("exposes UTC timing and internal pause state without inventing a legacy owner", async () => {
    const label = "cron-process-notification-queue"
    await owner("paused", label).expect(200)
    await post(label).expect(409)
    await owner("legacy", label).expect(400)
    const schedules = await request(app.getHttpServer())
      .get("/v1/admin/crons")
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(
      schedules.body.items.find((item: { label: string }) => item.label === label)
    ).toMatchObject({
      timezone: "UTC",
      owner: "paused",
      legacy_enabled: null,
      effective_enabled: false,
    })
    await owner("api", label).expect(200)
    await post(label).expect(202)
  })
})
