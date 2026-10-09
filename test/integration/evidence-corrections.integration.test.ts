import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthModule } from "../../src/auth/auth.module.js"
import { IdentityService } from "../../src/auth/identity.service.js"
import { DbModule } from "../../src/db/db.module.js"
import type { DbService } from "../../src/db/db.service.js"
import { AdminCorrectionReportController } from "../../src/admin/admin-correction-report.controller.js"
import { AdminCorrectionReportRepository } from "../../src/admin/admin-correction-report.repository.js"
import {
  CorrectionReportCapabilityController,
  CorrectionReportController,
} from "../../src/consumer/correction-report.controller.js"
import { CorrectionReportService } from "../../src/consumer/correction-report.service.js"
import { PgExceptionFilter } from "../../src/common/pg-exception.filter.js"
import { AdminEventEditorController } from "../../src/admin/admin-event-editor.controller.js"
import { AdminEventEditorService } from "../../src/admin/admin-event-editor.service.js"
import { AdminEventEditorRepository } from "../../src/admin/admin-event-editor.repository.js"
import { AdminFamilyNeedsController } from "../../src/evidence/admin-family-needs.controller.js"
import { AdminFamilyNeedsService } from "../../src/evidence/admin-family-needs.service.js"
import { AdminFamilyNeedsRepository } from "../../src/evidence/admin-family-needs.repository.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (["operator", "member", "disabled", "unmapped"].includes(token)) return { sub: token }
    throw new Error("invalid token")
  }),
}))
let db: DbService
let app: INestApplication
let actor: string
let member: string
let event: string
const identity = {
  resolve: async (id: string) =>
    id === "unmapped"
      ? null
      : {
          clerkUserId: id,
          supabaseUuid: id === "operator" ? actor : member,
          email: "fixture@example.com",
          role: id === "operator" ? "operator" : "member",
        },
  hasEnabledAccess: async (id: string) =>
    (await db.query("SELECT is_enabled FROM public.user_access WHERE user_id=$1", [id]))[0]
      ?.is_enabled === true,
}
beforeAll(async () => {
  db = createIntegrationDb()
  await db.query(
    "DROP TABLE IF EXISTS public.correction_reports, public.listing_corrections, private.correction_report_private, private.correction_report_capabilities, private.correction_report_recent_content, private.correction_reporter_restrictions CASCADE; DROP TYPE IF EXISTS public.correction_report_category, public.correction_report_status CASCADE; DROP FUNCTION IF EXISTS private.valid_correction_evidence_urls(text[]) CASCADE"
  )
  await ensureAdminCatalog(db)
  await db.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$`
  )
  await db.query(
    "DROP VIEW public.event_family_needs; DROP TABLE public.event_family_need_evidence; DROP TYPE public.family_need_claim, public.family_need_value, public.family_need_provenance CASCADE"
  )
  const evidenceMigration = readFileSync(
    "schema/migrations/20260902005000_family_needs_evidence.sql",
    "utf8"
  )
  // Reuse the ledger's exact evidence tables, view and invalidation trigger on the catalog.
  await db.query(
    evidenceMigration.slice(
      evidenceMigration.indexOf("CREATE TYPE public.family_need_claim"),
      evidenceMigration.indexOf("CREATE FUNCTION private.import_family_need_statements")
    )
  )
  await db.query(readFileSync("schema/migrations/20260902006000_correction_reports.sql", "utf8"))
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ CLERK_SECRET_KEY: "sk_test_evidence" })],
      }),
      DbModule,
      AuthModule,
    ],
    controllers: [
      AdminEventEditorController,
      AdminCorrectionReportController,
      CorrectionReportController,
      CorrectionReportCapabilityController,
      AdminFamilyNeedsController,
    ],
    providers: [
      AdminEventEditorService,
      AdminEventEditorRepository,
      AdminCorrectionReportRepository,
      CorrectionReportService,
      AdminFamilyNeedsService,
      AdminFamilyNeedsRepository,
    ],
  })
    .overrideProvider(IdentityService)
    .useValue(identity)
    .compile()
  app = module.createNestApplication()
  app.useGlobalFilters(new PgExceptionFilter(app.getHttpAdapter()))
  // DbModule's provider uses the same dedicated DATABASE_URL.
  await app.init()
})
afterAll(async () => {
  await app?.close()
  await db?.onModuleDestroy()
})
beforeEach(async () => {
  await db.query(
    "TRUNCATE public.correction_reports, public.listing_corrections, private.correction_report_capabilities, private.correction_report_recent_content, private.correction_reporter_restrictions CASCADE"
  )
  await truncateAdminCatalog(db)
  actor = randomUUID()
  member = randomUUID()
  event = randomUUID()
  await db.query("INSERT INTO auth.users(id) VALUES ($1),($2)", [actor, member])
  await db.query("INSERT INTO public.user_profiles(id,role) VALUES ($1,'admin'),($2,'user')", [
    actor,
    member,
  ])
  await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES ($1,true),($2,true)", [
    actor,
    member,
  ])
  await db.query(
    "INSERT INTO public.events(id,title,start_datetime,status) VALUES ($1,'Fixture event','2026-11-01T10:00:00.123456Z','published')",
    [event]
  )
})
describe("evidence and correction HTTP with disposable PostgreSQL", () => {
  it("returns the existing 200-row operator queue with titles without private payload", async () => {
    await db.query(
      "INSERT INTO public.correction_reports(event_id,category,details) SELECT $1,'other','Private fixture detail '||n FROM generate_series(1,201) n",
      [event]
    )
    const response = await request(app.getHttpServer())
      .get("/v1/admin/correction-reports?status=new&limit=200")
      .set("Authorization", "Bearer operator")
    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(200)
    expect(response.body[0]).toMatchObject({ event_id: event, event_title: "Fixture event" })
    expect(JSON.stringify(response.body)).not.toContain("Private fixture detail")
  })
  it("reuses a valid anonymous capability without consuming issuance budget", async () => {
    const first = await request(app.getHttpServer()).post("/v1/correction-report-capability")
    expect(first.status).toBe(204)
    const cookie = first.headers["set-cookie"]![0]!.split(";")[0]!
    const second = await request(app.getHttpServer())
      .post("/v1/correction-report-capability")
      .set("Cookie", cookie)
    expect(second.status).toBe(204)
    expect(second.headers["set-cookie"]).toBeUndefined()
    expect(
      (
        await db.query("SELECT count(*)::int AS count FROM private.correction_report_capabilities")
      )[0]?.count
    ).toBe(1)
  })

  it("lists current evidence ahead of invalidated history in legacy chronology with conflicts", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    await db.query(
      `INSERT INTO public.event_family_need_evidence(id,event_id,claim,value,provenance_type,statement,observed_at,applicable_start_datetime) VALUES ($1,$4,'stroller_friendly','supported','organizer','Older valid','2026-10-07T10:00:00Z','2026-11-01T10:00:00.123456Z'),($2,$4,'indoor','supported','human','Old invalid','2026-10-09T10:00:00Z','2026-11-01T10:00:00.123456Z'),($3,$4,'stroller_friendly','unsupported','human','New conflicting','2026-10-08T10:00:00Z','2026-11-01T10:00:00.123456Z')`,
      [...ids, event]
    )
    await db.query(
      "UPDATE public.event_family_need_evidence SET invalidated_at=now(),invalidation_reason='Operator reassessment' WHERE id=$1",
      [ids[1]]
    )
    const response = await request(app.getHttpServer())
      .get(`/v1/admin/events/${event}/family-needs`)
      .set("Authorization", "Bearer operator")
    expect(response.status).toBe(200)
    expect(response.body.map((row: { id: string }) => row.id)).toEqual([ids[2], ids[0], ids[1]])
    expect(response.body.map((row: { has_conflict: boolean }) => row.has_conflict)).toEqual([
      true,
      true,
      false,
    ])
  })

  it("rotates anonymous capabilities, rejects replay and duplicates, and keeps contact private", async () => {
    const minted = await request(app.getHttpServer()).post("/v1/correction-report-capability")
    const cookie = minted.headers["set-cookie"]![0]!.split(";")[0]!
    const submitted = await request(app.getHttpServer())
      .post(`/v1/events/${event}/correction-reports`)
      .set("Cookie", cookie)
      .send({
        category: "cancellation",
        details: "Cancelled fixture",
        contact: { email: "parent@example.com" },
        evidence_urls: ["https://example.com/proof"],
      })
    expect(submitted.status).toBe(201)
    expect(submitted.body).toMatchObject({ status: "new", priority: 0 })
    expect(JSON.stringify(submitted.body)).not.toContain("parent@example.com")
    const replacement = submitted.headers["set-cookie"]![0]!.split(";")[0]!
    expect(replacement).not.toBe(cookie)
    const replay = await request(app.getHttpServer())
      .post(`/v1/events/${event}/correction-reports`)
      .set("Cookie", cookie)
      .send({ category: "other", details: "Second fixture" })
    expect(replay.status).toBe(429)
    const duplicate = await request(app.getHttpServer())
      .post(`/v1/events/${event}/correction-reports`)
      .set("Cookie", replacement)
      .send({
        category: "cancellation",
        details: "Cancelled fixture",
        contact: { email: "different@example.com" },
      })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.message).toBe("report already received")
    const detail = await request(app.getHttpServer())
      .get(`/v1/admin/correction-reports/${submitted.body.id}`)
      .set("Authorization", "Bearer operator")
    expect(detail.body).toMatchObject({
      event_title: "Fixture event",
      contact: { email: "parent@example.com" },
      evidence: ["https://example.com/proof"],
    })
    expect(
      (
        await request(app.getHttpServer())
          .get(`/v1/admin/correction-reports/${submitted.body.id}`)
          .set("Authorization", "Bearer member")
      ).status
    ).toBe(404)
    expect(
      (await request(app.getHttpServer()).get(`/v1/admin/correction-reports/${submitted.body.id}`))
        .status
    ).toBe(401)
    const stillUsable = await request(app.getHttpServer())
      .post(`/v1/events/${event}/correction-reports`)
      .set("Cookie", replacement)
      .send({ category: "other", details: "Third fixture" })
    expect(stillUsable.status).toBe(201)
  })
  it("claims and resolves only attributable corrections, retains conflicts, and deletes private data after disposition", async () => {
    const submitted = await request(app.getHttpServer())
      .post(`/v1/events/${event}/correction-reports`)
      .set("Authorization", "Bearer member")
      .send({
        category: "wrong_location",
        details: "Address changed",
        contact: { email: "parent@example.com" },
      })
    expect(submitted.status).toBe(201)
    const id = submitted.body.id
    const base = `/v1/admin/correction-reports/${id}`
    expect(
      (
        await request(app.getHttpServer())
          .post(`${base}/claim`)
          .set("Authorization", "Bearer operator")
          .send({ version: 1 })
      ).body
    ).toMatchObject({ status: "in_review", version: 2, claimed_by: actor })
    expect(
      (
        await request(app.getHttpServer())
          .post(`${base}/claim`)
          .set("Authorization", "Bearer operator")
          .send({ version: 1 })
      ).status
    ).toBe(409)
    const edit = await request(app.getHttpServer())
      .put(`/v1/admin/events/${event}`)
      .set("Authorization", "Bearer operator")
      .send({
        patch: { address: "Correct library" },
        tag_ids: [],
        decision_reason: "Report correction",
      })
    expect(edit.status).toBe(200)
    const audit = (
      await db.query(
        "SELECT id FROM public.admin_audit_log WHERE target_id=$1 AND action='event.update' ORDER BY created_at DESC LIMIT 1",
        [event]
      )
    )[0]!
    const link = await request(app.getHttpServer())
      .post(`${base}/correction`)
      .set("Authorization", "Bearer operator")
      .send({ audit_log_id: audit.id, note: "Corrected address" })
    expect(link.status).toBe(201)
    const stale = await request(app.getHttpServer())
      .post(`${base}/disposition`)
      .set("Authorization", "Bearer operator")
      .send({ version: 1, outcome: "resolved", note: "Fixed", correction_id: link.body.id })
    expect(stale.status).toBe(409)
    const resolved = await request(app.getHttpServer())
      .post(`${base}/disposition`)
      .set("Authorization", "Bearer operator")
      .send({ version: 2, outcome: "resolved", note: "Fixed", correction_id: link.body.id })
    expect(resolved.status).toBe(201)
    expect(resolved.body).toMatchObject({
      status: "resolved",
      version: 3,
      correction_id: link.body.id,
    })
    const detail = await request(app.getHttpServer())
      .get(base)
      .set("Authorization", "Bearer operator")
    expect(detail.body.contact).toBeNull()
    expect(detail.body.evidence).toBeNull()
  })

  it("rejects invalid report limits and changed database operator authorization with safe client errors", async () => {
    expect(
      (
        await request(app.getHttpServer())
          .get("/v1/admin/correction-reports?limit=201")
          .set("Authorization", "Bearer operator")
      ).status
    ).toBe(400)
    await db.query("UPDATE public.user_profiles SET role='user' WHERE id=$1", [actor])
    expect(
      (
        await request(app.getHttpServer())
          .get("/v1/admin/correction-reports")
          .set("Authorization", "Bearer operator")
      ).status
    ).toBe(403)
    expect(
      (
        await request(app.getHttpServer())
          .get(`/v1/admin/events/${event}/family-needs`)
          .set("Authorization", "Bearer operator")
      ).status
    ).toBe(403)
  })

  it("preserves evidence conflicts, reassessment, material invalidation and truthful unknown states", async () => {
    const auth = "Bearer operator"
    const path = `/v1/admin/events/${event}/family-needs`
    const first = await request(app.getHttpServer())
      .post(`${path}/evidence`)
      .set("Authorization", auth)
      .send({
        claim: "indoor",
        value: "supported",
        provenance_type: "organizer",
        statement: "Indoor library",
        observed_at: "2026-10-08T10:00:00Z",
      })
    expect(first.status).toBe(200)
    expect(first.body.applicable_start_datetime).toContain(".123456")
    const second = await request(app.getHttpServer())
      .post(`${path}/evidence`)
      .set("Authorization", auth)
      .send({
        claim: "indoor",
        value: "unsupported",
        provenance_type: "human",
        statement: "Outdoor courtyard",
        observed_at: "2026-10-09T10:00:00Z",
      })
    expect(second.status).toBe(200)
    expect(
      (await request(app.getHttpServer()).get(path).set("Authorization", auth)).body.every(
        (row: { has_conflict: boolean }) => row.has_conflict
      )
    ).toBe(true)
    expect(
      (
        await request(app.getHttpServer())
          .post(`${path}/reassess`)
          .set("Authorization", auth)
          .send({ evidence_id: second.body.id, reason: "Different occurrence" })
      ).status
    ).toBe(200)
    expect(
      (await request(app.getHttpServer()).get(path).set("Authorization", auth)).body.every(
        (row: { has_conflict: boolean }) => !row.has_conflict
      )
    ).toBe(true)
    const edit = await request(app.getHttpServer())
      .put(`/v1/admin/events/${event}`)
      .set("Authorization", auth)
      .send({ patch: { address: "New venue" }, tag_ids: [], decision_reason: "Moved" })
    expect(edit.status).toBe(200)
    expect(edit.body).not.toHaveProperty("human_reviewed")
    expect(edit.body).not.toHaveProperty("organizer_confirmed")
    const history = await request(app.getHttpServer()).get(path).set("Authorization", auth)
    expect(
      history.body.every((row: { invalidated_at: string | null }) => row.invalidated_at !== null)
    ).toBe(true)
    expect(
      (
        await db.query(
          "SELECT state FROM public.event_family_needs WHERE event_id=$1 AND claim='indoor'",
          [event]
        )
      )[0]?.state
    ).toBe("unknown")
  })
  it("retains signed-in five-report limits and disabled/expired-session rejection", async () => {
    for (let index = 0; index < 5; index++)
      expect(
        (
          await request(app.getHttpServer())
            .post(`/v1/events/${event}/correction-reports`)
            .set("Authorization", "Bearer member")
            .send({ category: "other", details: `Fixture ${index}` })
        ).status
      ).toBe(201)
    expect(
      (
        await request(app.getHttpServer())
          .post(`/v1/events/${event}/correction-reports`)
          .set("Authorization", "Bearer member")
          .send({ category: "other", details: "Sixth fixture" })
      ).status
    ).toBe(429)
    await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [member])
    expect(
      (
        await request(app.getHttpServer())
          .post("/v1/correction-report-capability")
          .set("Authorization", "Bearer member")
      ).status
    ).toBe(403)
    expect(
      (
        await request(app.getHttpServer())
          .post(`/v1/events/${event}/correction-reports`)
          .set("Authorization", "Bearer member")
          .send({ category: "other", details: "Disabled fixture" })
      ).status
    ).toBe(403)
    expect(
      (
        await request(app.getHttpServer())
          .post("/v1/correction-report-capability")
          .set("Authorization", "Bearer expired")
      ).status
    ).toBe(401)
  })

  it("rejects undeclared reporter identities and invalid private report input as validation errors", async () => {
    const invalid = await request(app.getHttpServer())
      .post(`/v1/events/${event}/correction-reports`)
      .send({ category: "other", details: "Fixture", reporter_user_id: actor })
    expect(invalid.status).toBe(400)
    expect(invalid.body).not.toHaveProperty("reporter_user_id")
  })

  it("retains the 20-anonymous-report event limit and 120-capability issuance limit", async () => {
    let minted = await request(app.getHttpServer()).post("/v1/correction-report-capability")
    let cookie = minted.headers["set-cookie"]![0]!.split(";")[0]!
    for (let index = 0; index < 20; index++) {
      const submitted = await request(app.getHttpServer())
        .post(`/v1/events/${event}/correction-reports`)
        .set("Cookie", cookie)
        .send({ category: "other", details: `Anonymous fixture ${index}` })
      expect(submitted.status).toBe(201)
      cookie = submitted.headers["set-cookie"]![0]!.split(";")[0]!
    }
    expect(
      (
        await request(app.getHttpServer())
          .post(`/v1/events/${event}/correction-reports`)
          .set("Cookie", cookie)
          .send({ category: "other", details: "Twenty-first fixture" })
      ).status
    ).toBe(429)
    await db.query("TRUNCATE private.correction_report_capabilities")
    await db.query(
      "INSERT INTO private.correction_report_capabilities(token_hash,expires_at) SELECT decode(md5(n::text)||md5(n::text),'hex'),now()+interval '15 minutes' FROM generate_series(1,120) n"
    )
    minted = await request(app.getHttpServer()).post("/v1/correction-report-capability")
    expect(minted.status).toBe(429)
    expect(minted.headers["set-cookie"]).toBeUndefined()
  })
})
