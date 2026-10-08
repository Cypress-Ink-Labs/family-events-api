import { randomUUID } from "node:crypto"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { AuthModule } from "../../src/auth/auth.module.js"
import { IdentityService } from "../../src/auth/identity.service.js"
import { DbModule } from "../../src/db/db.module.js"
import type { DbService } from "../../src/db/db.service.js"
import { DbService as DbProvider } from "../../src/db/db.service.js"
import { JobsService } from "../../src/jobs/jobs.service.js"
import { AdminSourceController } from "../../src/admin/admin-source.controller.js"
import { AdminSourceService } from "../../src/admin/admin-source.service.js"
import { AdminSourceRepository } from "../../src/admin/admin-source.repository.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"
vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (["operator", "member", "unmapped"].includes(token)) return { sub: token }
    throw new Error("invalid")
  }),
}))
let db: DbService,
  app: INestApplication,
  actor: string,
  source: string,
  other: string,
  event: string,
  run: string,
  older: string
const jobs = { send: vi.fn() }
const raw = "2026-10-08 18:00:00.123456+00"
beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ CLERK_SECRET_KEY: "sk_test_diagnostics" })],
      }),
      DbModule,
      AuthModule,
    ],
    controllers: [AdminSourceController],
    providers: [
      AdminSourceService,
      AdminSourceRepository,
      { provide: JobsService, useValue: jobs },
    ],
  })
    .overrideProvider(DbProvider)
    .useValue(db)
    .overrideProvider(IdentityService)
    .useValue({
      resolve: async (id: string) =>
        id === "unmapped"
          ? null
          : {
              clerkUserId: id,
              supabaseUuid: actor,
              email: "fixture@example.com",
              role: id === "member" ? "member" : "operator",
            },
      hasEnabledAccess: async () =>
        (await db.query("SELECT is_enabled FROM public.user_access WHERE user_id=$1", [actor]))[0]
          ?.is_enabled === true,
    })
    .compile()
  app = module.createNestApplication()
  await app.init()
})
afterAll(async () => {
  if (app) await app.close()
  else if (db) await db.onModuleDestroy()
})
beforeEach(async () => {
  await truncateAdminCatalog(db)
  jobs.send.mockReset()
  actor = randomUUID()
  source = randomUUID()
  other = randomUUID()
  event = randomUUID()
  run = randomUUID()
  older = randomUUID()
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [actor])
  await db.query("INSERT INTO public.user_profiles(id,role) VALUES($1,'admin')", [actor])
  await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES($1,true)", [actor])
  await db.query(
    "INSERT INTO public.event_sources(id,name,url,source_type,is_active) VALUES($1,'Library','https://example.com','website',true),($2,'Other','https://example.com/other','website',true)",
    [source, other]
  )
  await db.query(
    "INSERT INTO public.events(id,title,start_datetime,status,source_id) VALUES($1,'Story',now(),'draft',$2)",
    [event, source]
  )
  await db.query(
    "INSERT INTO public.source_runs(id,source_id,started_at,completed_at,status,error_log,events_found,events_imported,events_skipped) VALUES($1,$2,$3,$3,'error','Fixture parser error',3,1,2),($4,$2,'2026-10-08 18:00:00.123455+00',null,'running',null,0,0,0),($5,$6,now(),null,'running',null,0,0,0)",
    [run, source, raw, older, randomUUID(), other]
  )
})
function get(path: string, token = "operator") {
  return request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`)
}
it("returns filtered source runs with exact cursors and protected extraction logs", async () => {
  await db.query(
    "INSERT INTO public.source_extraction_traces(id,source_id,source_run_id,extraction_mode,extractor,status,error,created_at) OVERRIDING SYSTEM VALUE VALUES(9007199254740993,$1,$2,'deterministic','deterministic','error','Fixture parse failure',$3)",
    [source, run, raw]
  )
  const first = await get(`/v1/admin/sources/runs?source_id=${source}&limit=1`).expect(200)
  expect(first.body.runs[0]).toMatchObject({
    id: run,
    source_name: "Library",
    error_log: "Fixture parser error",
    started_at: raw,
    events_found: 3,
    events_imported: 1,
    events_skipped: 2,
  })
  expect(first.body.total_count).toBe(2)
  expect(first.body.next_cursor).toEqual({ after_started_at: raw, after_id: run })
  const second = await get(
    `/v1/admin/sources/runs?source_id=${source}&limit=1&after_started_at=${encodeURIComponent(raw)}&after_id=${run}`
  ).expect(200)
  expect(second.body.runs.map((row: { id: string }) => row.id)).toEqual([older])
  expect(second.body.next_cursor).toBeNull()
  const detail = await get(`/v1/admin/sources/runs/${run}`).expect(200)
  expect(detail.body.traces[0]).toMatchObject({
    id: "9007199254740993",
    error: "Fixture parse failure",
    created_at: raw,
  })
  expect((await get(`/v1/admin/sources/runs?status=error`).expect(200)).body.total_count).toBe(1)
  await get(`/v1/admin/sources/runs/${randomUUID()}`).expect(404)
  expect(jobs.send).not.toHaveBeenCalled()
})
it("reads active source/tag queues, complete summaries and exact bigint paging without mutating rows", async () => {
  await db.query(
    "INSERT INTO public.source_scrape_queue(id,source_id,source_run_id,status,enqueued_at,attempt_count,last_error) OVERRIDING SYSTEM VALUE VALUES(9007199254740993,$1,$2,'retrying',$3,2,'Fixture retry'),(9007199254740994,$4,null,'processing',$3,1,null),(9007199254740995,$1,$2,'dead',$3,4,'Fixture dead')",
    [source, run, raw, other]
  )
  await db.query(
    "INSERT INTO public.event_tag_queue(id,event_id,source_run_id,status,enqueued_at,attempt_count,last_error) OVERRIDING SYSTEM VALUE VALUES(9007199254740997,$1,$2,'pending',$3,1,'Fixture tag')",
    [event, run, raw]
  )
  const first = await get("/v1/admin/sources/queues?kind=source&limit=1").expect(200)
  expect(first.body.total_count).toBe(2)
  expect(first.body.next_cursor).toBe("9007199254740993")
  expect(first.body.rows[0]).toMatchObject({
    id: "9007199254740993",
    entity_id: source,
    entity_name: "Library",
    source_run_id: run,
    status: "retrying",
    last_error: "Fixture retry",
    enqueued_at: raw,
  })
  expect(first.body.summary).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "dead", row_count: 1 })])
  )
  expect(
    (
      await get("/v1/admin/sources/queues?kind=source&limit=1&after_id=9007199254740993").expect(
        200
      )
    ).body.rows[0].id
  ).toBe("9007199254740994")
  expect(
    (await get(`/v1/admin/sources/queues?kind=source&source_id=${source}`).expect(200)).body
      .total_count
  ).toBe(1)
  expect(
    (await get(`/v1/admin/sources/queues?kind=tag&source_id=${source}`).expect(200)).body.rows[0]
  ).toMatchObject({
    id: "9007199254740997",
    entity_id: event,
    entity_name: "Story",
    source_id: source,
    status: "pending",
  })
  expect(
    (await db.query("SELECT status::text FROM public.source_scrape_queue ORDER BY id")).map(
      (row) => row.status
    )
  ).toEqual(["retrying", "processing", "dead"])
  expect(jobs.send).not.toHaveBeenCalled()
})
it("conceals diagnostics and rejects revoked/database-denied operators and invalid filters", async () => {
  for (const path of [
    "/v1/admin/sources/runs",
    "/v1/admin/sources/queues?kind=source",
    `/v1/admin/sources/runs/${run}`,
  ]) {
    await request(app.getHttpServer()).get(path).expect(401)
    await get(path, "member").expect(404)
    await get(path, "unmapped").expect(403)
  }
  for (const query of [
    "kind=invalid",
    "kind=source&after_id=9e3",
    "kind=source&limit=201",
    "kind=tag&source_id=nope",
    "kind=source&actor=spoof",
  ])
    await get(`/v1/admin/sources/queues?${query}`).expect(400)
  for (const query of [
    "status=invalid",
    "after_id=" + run,
    "limit=0",
    "after_started_at=2026-02-30T00:00:00Z&after_id=" + run,
  ])
    await get(`/v1/admin/sources/runs?${query}`).expect(400)
  await db.query("UPDATE public.user_profiles SET role='user' WHERE id=$1", [actor])
  await get("/v1/admin/sources/runs").expect(403)
  await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [actor])
  await get("/v1/admin/sources/queues?kind=tag").expect(403)
})
