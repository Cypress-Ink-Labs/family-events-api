import { randomUUID } from "node:crypto"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthModule } from "../../src/auth/auth.module.js"
import { IdentityService } from "../../src/auth/identity.service.js"
import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { AdminReviewController } from "../../src/admin/admin-review.controller.js"
import { AdminReviewService } from "../../src/admin/admin-review.service.js"
import { AdminReviewRepository } from "../../src/admin/admin-review.repository.js"
import { AdminEventEditorController } from "../../src/admin/admin-event-editor.controller.js"
import { AdminEventEditorService } from "../../src/admin/admin-event-editor.service.js"
import { AdminEventEditorRepository } from "../../src/admin/admin-event-editor.repository.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (["operator", "member", "revoked", "unmapped"].includes(token)) return { sub: token }
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
          supabaseUuid: id === "member" ? member : actor,
          email: "fixture@example.com",
          role: id === "member" ? "member" : "operator",
        },
  hasEnabledAccess: async (id: string) =>
    (await db.query("SELECT is_enabled FROM public.user_access WHERE user_id=$1", [id]))[0]
      ?.is_enabled === true,
}
beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ CLERK_SECRET_KEY: "sk_test_operators" })],
      }),
      DbModule,
      AuthModule,
    ],
    controllers: [AdminReviewController, AdminEventEditorController],
    providers: [
      AdminReviewService,
      AdminReviewRepository,
      AdminEventEditorService,
      AdminEventEditorRepository,
    ],
  })
    .overrideProvider(IdentityService)
    .useValue(identity)
    .overrideProvider(DbService)
    .useValue(db)
    .compile()
  app = module.createNestApplication()
  await app.init()
})
beforeEach(async () => {
  await truncateAdminCatalog(db)
  actor = randomUUID()
  member = randomUUID()
  event = randomUUID()
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [actor, member])
  await db.query("INSERT INTO public.user_profiles(id,role) VALUES($1,'admin'),($2,'user')", [
    actor,
    member,
  ])
  await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES($1,true),($2,true)", [
    actor,
    member,
  ])
  await db.query(
    `INSERT INTO public.events(id,title,start_datetime,status,llm_review_status,llm_review_decision,llm_review_confidence,llm_review_flags,llm_review_reason,llm_review_provider,llm_review_model,llm_review_prompt_version,llm_reviewed_at,admin_locked_fields,admin_last_edited_by,admin_last_edited_at)
    VALUES($1,'Review fixture','2035-03-08T18:00:00.123456Z','draft','succeeded','needs_admin_review',0.700,ARRAY['age_uncertain'],'Check age range','gemini','fixture-model','v1','2026-10-08T18:00:00.654321Z',ARRAY['title'],$2,'2026-10-08T17:00:00.123456Z')`,
    [event, actor]
  )
})
afterAll(async () => {
  if (app) await app.close()
  else await db?.onModuleDestroy()
})

describe("operator review over HTTP and PostgreSQL", () => {
  it("returns latest AI trace and complete review/audit diagnostics only to enabled operators", async () => {
    await db.query(
      `INSERT INTO public.event_ai_traces(event_id,trigger_type,provider,model,status,input_title,available_tag_slugs,predicted_tags,reasoning_summary,created_at)
      VALUES($1,'manual-review','ollama','fixture-model','success','Old input','["outdoor"]'::jsonb,'[]','Older trace','2026-10-08T16:00:00Z'),
      ($1,'manual-review','ollama','fixture-model','success','Newest input','["indoor"]'::jsonb,'[{"slug":"indoor","confidence":0.8}]','Newest trace','2026-10-08T18:00:00.654321Z')`,
      [event]
    )
    const result = await request(app.getHttpServer())
      .get(`/v1/admin/events/${event}/diagnostics`)
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(result.body.review).toMatchObject({
      id: event,
      title: "Review fixture",
      llm_review_decision: "needs_admin_review",
      llm_review_confidence: "0.700",
      llm_review_flags: ["age_uncertain"],
      admin_locked_fields: ["title"],
      admin_last_edited_by: actor,
    })
    expect(result.body.review.llm_reviewed_at).toContain(".654321")
    expect(result.body.trace).toMatchObject({
      reasoning_summary: "Newest trace",
      input_title: "Newest input",
      predicted_tags: [{ slug: "indoor", confidence: 0.8 }],
    })
    for (const [token, status] of [
      [null, 401],
      ["member", 404],
      ["unmapped", 403],
      ["bad", 401],
    ] as const) {
      const operation = request(app.getHttpServer()).get(`/v1/admin/events/${event}/diagnostics`)
      if (token) operation.set("Authorization", `Bearer ${token}`)
      await operation.expect(status)
    }
    await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [actor])
    await request(app.getHttpServer())
      .get(`/v1/admin/events/${event}/diagnostics`)
      .set("Authorization", "Bearer operator")
      .expect(403)
  })
  it("keeps filters, timestamp cursors, status reasons, tag overrides and audit attribution coherent", async () => {
    const source = randomUUID(),
      city = randomUUID(),
      tag = randomUUID(),
      second = randomUUID()
    await db.query(
      "INSERT INTO public.cities(id,name,slug,timezone,is_active) VALUES($1,'Retired City','retired','America/Chicago',false)",
      [city]
    )
    await db.query(
      "INSERT INTO public.event_sources(id,name,url,city_id) VALUES($1,'Calendar','https://fixture.invalid/calendar',$2)",
      [source, city]
    )
    await db.query(
      "INSERT INTO public.tags(id,name,slug,color) VALUES($1,'Outdoor','outdoor','#123456')",
      [tag]
    )
    await db.query(
      "UPDATE public.events SET source_id=$2,city_id=$3,created_at='2026-10-08T18:00:00.123456Z' WHERE id=$1",
      [event, source, city]
    )
    await db.query(
      "INSERT INTO public.events(id,title,status,start_datetime,source_id,city_id,llm_review_status,llm_review_decision,llm_reviewed_at,created_at) VALUES($1,'Second','draft','2035-03-09T18:00:00Z',$2,$3,'succeeded','needs_admin_review','2026-10-08T18:00:00Z','2026-10-08T18:00:00.123457Z')",
      [second, source, city]
    )
    const query = {
      city_id: city,
      source_id: source,
      llm_review_status: "succeeded",
      llm_review_decision: "needs_admin_review",
      llm_reviewed: "true",
      limit: "1",
    }
    const page = await request(app.getHttpServer())
      .get("/v1/admin/events")
      .query(query)
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(page.body.events.map((row: { id: string }) => row.id)).toEqual([second])
    expect(page.body.total_count).toBe(2)
    expect(page.body.next_cursor.after_created_at).toContain(".123457")
    const next = await request(app.getHttpServer())
      .get("/v1/admin/events")
      .query({ ...query, ...page.body.next_cursor })
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(next.body.events.map((row: { id: string }) => row.id)).toEqual([event])
    expect(next.body.next_cursor).toBeNull()
    await request(app.getHttpServer())
      .put(`/v1/admin/events/${event}/status`)
      .set("Authorization", "Bearer operator")
      .send({ status: "published", reason: "Verified listing" })
      .expect(200)
    await request(app.getHttpServer())
      .put(`/v1/admin/events/${event}/status`)
      .set("Authorization", "Bearer operator")
      .send({ status: "draft", reason: "Revisit date" })
      .expect(200)
    const edited = await request(app.getHttpServer())
      .put(`/v1/admin/events/${event}`)
      .set("Authorization", "Bearer operator")
      .send({
        patch: {},
        tag_ids: [tag],
        lock_edited_fields: false,
        decision_reason: "Correct tag assignment",
      })
      .expect(200)
    expect(edited.body.event.admin_locked_fields).toEqual(["title"])
    expect(edited.body.tags[0]).toMatchObject({ id: tag, is_manual_override: true })
    const audit = await db.query(
      "SELECT admin_user_id,action FROM public.admin_audit_log WHERE target_id=$1 ORDER BY created_at",
      [event]
    )
    expect(audit.length).toBeGreaterThanOrEqual(3)
    expect(audit.every((row) => row.admin_user_id === actor)).toBe(true)
    await request(app.getHttpServer())
      .post("/v1/admin/events/bulk-status")
      .set("Authorization", "Bearer operator")
      .send({ event_ids: [event, second], status: "rejected" })
      .expect(200)
    await request(app.getHttpServer())
      .post("/v1/admin/events/bulk-delete")
      .set("Authorization", "Bearer operator")
      .send({ event_ids: [second] })
      .expect(200)
    await request(app.getHttpServer())
      .get(`/v1/admin/events/${second}/diagnostics`)
      .set("Authorization", "Bearer operator")
      .expect(404)
  })
  it("preserves missing traces, validates ids and applies database admin access after the trusted mapping", async () => {
    const result = await request(app.getHttpServer())
      .get(`/v1/admin/events/${event}/diagnostics`)
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(result.body.trace).toBeNull()
    await request(app.getHttpServer())
      .get("/v1/admin/events/bad/diagnostics")
      .set("Authorization", "Bearer operator")
      .expect(400)
    await db.query("UPDATE public.user_profiles SET role='user' WHERE id=$1", [actor])
    await request(app.getHttpServer())
      .get(`/v1/admin/events/${event}/diagnostics`)
      .set("Authorization", "Bearer operator")
      .expect(403)
  })
})
