import { randomUUID } from "node:crypto"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthModule } from "../../src/auth/auth.module.js"
import { AdminContributionController } from "../../src/admin/admin-contribution.controller.js"
import { AdminContributionRepository } from "../../src/admin/admin-contribution.repository.js"
import { PgExceptionFilter } from "../../src/common/pg-exception.filter.js"
import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { CommentsRepository } from "../../src/data/comments.repository.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { integrationDatabaseUrl } from "./db.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === "operator" || token === "member") return { sub: `user_${token}` }
    throw new Error("invalid fixture token")
  }),
}))
describe("contribution administration HTTP", () => {
  let app: INestApplication
  let db: DbService
  let actor: string
  let member: string
  let eventId: string
  let commentId: string
  let ratingId: string
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              DATABASE_URL: integrationDatabaseUrl(),
              CLERK_SECRET_KEY: "sk_test_fixture",
              NODE_ENV: "test",
            }),
          ],
        }),
        DbModule,
        AuthModule,
      ],
      controllers: [AdminContributionController],
      providers: [AdminContributionRepository],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new PgExceptionFilter(app.getHttpAdapter()))
    await app.init()
    db = app.get(DbService)
    await ensureAdminCatalog(db)
    await db.query(
      "CREATE TABLE IF NOT EXISTS public.clerk_user_mapping(clerk_user_id text PRIMARY KEY,supabase_uuid uuid UNIQUE NOT NULL REFERENCES auth.users(id),email text NOT NULL,role text NOT NULL DEFAULT 'member',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())"
    )
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(async () => {
    await truncateAdminCatalog(db)
    await db.query("TRUNCATE public.clerk_user_mapping,auth.users CASCADE")
    actor = randomUUID()
    member = randomUUID()
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
      "INSERT INTO public.clerk_user_mapping(clerk_user_id,supabase_uuid,email,role) VALUES('user_operator',$1,'operator@example.test','operator'),('user_member',$2,'member@example.test','member')",
      [actor, member]
    )
    await db.query("UPDATE public.user_profiles SET display_name='Parent' WHERE id=$1", [member])
    const [city] = await db.query<{ id: string }>(
      "INSERT INTO public.cities(name,slug,timezone) VALUES('City','city','UTC') RETURNING id"
    )
    const [event] = await db.query<{ id: string }>(
      "INSERT INTO public.events(city_id,title,status,start_datetime,timezone) VALUES($1,'Family show','published',now()+interval '1 day','UTC') RETURNING id",
      [city!.id]
    )
    eventId = event!.id
    const [comment] = await db.query<{ id: string }>(
      "INSERT INTO public.comments(user_id,event_id,body) VALUES($1,$2,'Original') RETURNING id",
      [member, eventId]
    )
    commentId = comment!.id
    const [rating] = await db.query<{ id: string }>(
      "INSERT INTO public.ratings(user_id,event_id,score) VALUES($1,$2,5) RETURNING id",
      [member, eventId]
    )
    ratingId = rating!.id
  })
  const get = (path: string, token = "operator") =>
    request(app.getHttpServer()).get(`/v1/admin/${path}`).set("Authorization", `Bearer ${token}`)
  const put = (body: object) =>
    request(app.getHttpServer())
      .put(`/v1/admin/comments/${commentId}`)
      .set("Authorization", "Bearer operator")
      .send(body)
  const remove = (kind: string, id: string) =>
    request(app.getHttpServer())
      .delete(`/v1/admin/${kind}/${id}`)
      .set("Authorization", "Bearer operator")
  it("pages contributions with attribution, exact totals and legacy filters", async () => {
    await db.query(
      "INSERT INTO public.comments(user_id,event_id,body,is_approved,is_flagged) SELECT $1,$2,'Pending '||n,false,false FROM generate_series(1,51)n",
      [member, eventId]
    )
    const all = await get("comments?page=0&filter=all").expect(200)
    expect(all.body.totalCount).toBe(52)
    expect(all.body.rows).toHaveLength(50)
    expect(all.body.rows[0]).toMatchObject({
      user_id: member,
      event_id: eventId,
      display_name: "Parent",
      event_title: "Family show",
    })
    const next = await get("comments?page=1&filter=pending").expect(200)
    expect(next.body.totalCount).toBe(51)
    expect(next.body.rows).toHaveLength(1)
    expect((await get("comments?filter=approved").expect(200)).body.rows).toHaveLength(1)
    expect((await get("ratings").expect(200)).body).toMatchObject({
      totalCount: 1,
      rows: [{ id: ratingId, score: 5, display_name: "Parent", event_title: "Family show" }],
    })
  })
  it("hides, edits and approves without changing author/event, and audits the mapped actor", async () => {
    await put({ is_approved: false, is_flagged: true }).expect(200)
    expect(await new CommentsRepository(db).listEventComments(eventId)).toEqual([])
    expect((await get("comments?filter=flagged").expect(200)).body.totalCount).toBe(1)
    await put({ body: "  Corrected  ", is_approved: true, is_flagged: false }).expect(200)
    expect(await new CommentsRepository(db).listEventComments(eventId)).toMatchObject([
      { body: "Corrected", user_id: member, event_id: eventId },
    ])
    expect(
      await db.query(
        "SELECT admin_user_id,target_id,metadata FROM public.admin_audit_log WHERE action='update_comment' ORDER BY created_at"
      )
    ).toMatchObject([
      {
        admin_user_id: actor,
        target_id: commentId,
        metadata: { before: { body: "Original" }, after: { is_approved: false } },
      },
      { admin_user_id: actor, metadata: { after: { body: "Corrected", user_id: member } } },
    ])
  })
  it("deletes selected comments/ratings and changes public results", async () => {
    await remove("comments", commentId).expect(200)
    await remove("ratings", ratingId).expect(200)
    expect(await new CommentsRepository(db).listEventComments(eventId)).toEqual([])
    expect(await db.query("SELECT score FROM public.ratings WHERE event_id=$1", [eventId])).toEqual(
      []
    )
    expect((await get("ratings").expect(200)).body.totalCount).toBe(0)
    expect(
      await db.query("SELECT action,admin_user_id FROM public.admin_audit_log ORDER BY created_at")
    ).toMatchObject([
      { action: "delete_comment", admin_user_id: actor },
      { action: "delete_rating", admin_user_id: actor },
    ])
    await remove("comments", commentId).expect(404)
  })
  it("conceals operators, rechecks database access, validates targets and denies attribution changes", async () => {
    await request(app.getHttpServer()).get("/v1/admin/comments").expect(401)
    await get("comments", "member").expect(404)
    for (const body of [
      {},
      { body: " " },
      { body: "x".repeat(4001) },
      { is_approved: "false" },
      { user_id: actor },
      { event_id: randomUUID() },
    ])
      await put(body).expect(400)
    await get("comments?page=-1").expect(400)
    await get("comments?filter=other").expect(400)
    await remove("ratings", "invalid").expect(400)
    await remove("comments", randomUUID()).expect(404)
    await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [actor])
    await put({ body: "Blocked" }).expect(403)
    expect(await db.query("SELECT body FROM public.comments WHERE id=$1", [commentId])).toEqual([
      { body: "Original" },
    ])
  })
  it("rolls back edits/deletes when their attribution audit fails", async () => {
    await db.query(
      "CREATE OR REPLACE FUNCTION private.reject_contribution_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$"
    )
    await db.query(
      "CREATE TRIGGER reject_contribution_audit BEFORE INSERT ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION private.reject_contribution_audit()"
    )
    try {
      await put({ body: "Discarded" }).expect(500)
      await remove("comments", commentId).expect(500)
      await remove("ratings", ratingId).expect(500)
    } finally {
      await db.query("DROP TRIGGER reject_contribution_audit ON public.admin_audit_log")
    }
    expect(await db.query("SELECT body FROM public.comments WHERE id=$1", [commentId])).toEqual([
      { body: "Original" },
    ])
    expect(await db.query("SELECT score FROM public.ratings WHERE id=$1", [ratingId])).toEqual([
      { score: 5 },
    ])
  })
})
