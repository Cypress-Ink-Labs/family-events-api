import { randomUUID } from "node:crypto"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthModule } from "../../src/auth/auth.module.js"
import { AdminAiController } from "../../src/admin/admin-ai.controller.js"
import { AdminAiRepository } from "../../src/admin/admin-ai.repository.js"
import { PgExceptionFilter } from "../../src/common/pg-exception.filter.js"
import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { readFileSync } from "node:fs"
import { ClassificationRepository } from "../../src/pipeline/classification/classification.repository.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { integrationDatabaseUrl } from "./db.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === "operator" || token === "member") return { sub: `user_${token}` }
    throw new Error("invalid fixture token")
  }),
}))
describe("AI settings and dashboard health HTTP", () => {
  let app: INestApplication
  let db: DbService
  let actor: string
  let member: string
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
      controllers: [AdminAiController],
      providers: [AdminAiRepository],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new PgExceptionFilter(app.getHttpAdapter()))
    await app.init()
    db = app.get(DbService)
    await ensureAdminCatalog(db)
    await db.query("DROP TABLE IF EXISTS private.operator_presence")
    await db.query(readFileSync("schema/migrations/20261008007000_operator_presence.sql", "utf8"))
    await db.query(readFileSync("test/integration/sql/ai_feature_config.sql", "utf8"))
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
    await db.query("TRUNCATE private.operator_presence")
    await db.query(
      "INSERT INTO public.approved_ai_models(id,provider,display_name,cost_tier,is_enabled) VALUES('fixture-model','openai','Approved fixture','low',true),('disabled-model','openai','Disabled fixture','high',false)"
    )
    await db.query(
      "INSERT INTO public.ai_feature_config(feature,model_id,enabled) VALUES('tagging','fixture-model',true)"
    )
  })
  const get = (path: string, token = "operator") =>
    request(app.getHttpServer()).get(`/v1/admin/${path}`).set("Authorization", `Bearer ${token}`)
  const put = (feature: string, body: object, token = "operator") =>
    request(app.getHttpServer())
      .put(`/v1/admin/ai/features/${feature}`)
      .set("Authorization", `Bearer ${token}`)
      .send(body)
  it("lists only approved enabled models and persisted feature attribution", async () => {
    const result = await get("ai").expect(200)
    expect(result.body.models).toHaveLength(1)
    expect(result.body.models[0]).toMatchObject({
      id: "fixture-model",
      provider: "openai",
      cost_tier: "low",
    })
    expect(result.body.features).toMatchObject([
      { feature: "tagging", model_id: "fixture-model", enabled: true },
    ])
  })
  it("updates approved assignments and flags used by the existing pipeline, with mapped attribution", async () => {
    await put("tagging", { model_id: "fixture-model", enabled: false }).expect(200)
    expect(await new ClassificationRepository(db).loadTagFeatureConfig()).toEqual({
      modelId: "fixture-model",
      provider: "openai",
      enabled: false,
    })
    await put("review-memory", { model_id: "fixture-model", enabled: true }).expect(200)
    expect(await new ClassificationRepository(db).getMemoryFeatureFlag("review-memory")).toEqual({
      enabled: true,
    })
    expect(
      await db.query(
        "SELECT updated_by FROM public.ai_feature_config WHERE feature='review-memory'"
      )
    ).toEqual([{ updated_by: actor }])
    expect(
      await db.query(
        "SELECT admin_user_id,action,metadata FROM public.admin_audit_log WHERE action='update_ai_feature' ORDER BY created_at"
      )
    ).toMatchObject([
      { admin_user_id: actor, metadata: { after: { feature: "tagging", enabled: false } } },
      { admin_user_id: actor, metadata: { after: { feature: "review-memory", enabled: true } } },
    ])
  })
  it("blocks unapproved/disabled models, invalid flags, author overrides and revoked access", async () => {
    await request(app.getHttpServer()).get("/v1/admin/ai").expect(401)
    await get("ai", "member").expect(404)
    for (const body of [
      { model_id: "missing", enabled: true },
      { model_id: "disabled-model", enabled: true },
      { model_id: "fixture-model", enabled: "false" },
      { model_id: "fixture-model", enabled: true, updated_by: member },
    ])
      await put("tagging", body).expect(400)
    await put("unknown", { model_id: "fixture-model", enabled: true }).expect(400)
    await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [actor])
    await put("tagging", { model_id: "fixture-model", enabled: false }).expect(403)
    expect(await new ClassificationRepository(db).loadTagFeatureConfig()).toMatchObject({
      enabled: true,
    })
  })
  it("retains the assignment if its audit cannot commit", async () => {
    await db.query(
      "CREATE OR REPLACE FUNCTION private.reject_ai_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$"
    )
    await db.query(
      "CREATE TRIGGER reject_ai_audit BEFORE INSERT ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION private.reject_ai_audit()"
    )
    try {
      await put("tagging", { model_id: "fixture-model", enabled: false }).expect(500)
    } finally {
      await db.query("DROP TRIGGER reject_ai_audit ON public.admin_audit_log")
    }
    expect(await new ClassificationRepository(db).loadTagFeatureConfig()).toMatchObject({
      enabled: true,
    })
  })
  it("shows recent ingestion and truthful ownership, excluding expired or revoked presence", async () => {
    await db.query(
      "INSERT INTO public.source_runs(status,events_imported,events_skipped,started_at) VALUES('success',3,2,now()),('error',0,1,now()-interval '8 days')"
    )
    await db.query(
      "INSERT INTO private.cron_enabled(label,enabled) VALUES('cron-tag-queue',false),('nestjs:cron-tag-queue',false),('internal:notify:process-notification-queue',false)"
    )
    await db.query("INSERT INTO private.operator_presence(user_id,last_seen_at) VALUES($1,now())", [
      member,
    ])
    const result = await get("dashboard/health").expect(200)
    expect(result.body.presence).toEqual([{ user_id: actor, display_name: "Admin" }])
    await db.query("UPDATE public.user_profiles SET role='admin' WHERE id=$1", [member])
    await db.query("UPDATE public.clerk_user_mapping SET role='operator' WHERE supabase_uuid=$1", [
      member,
    ])
    expect((await get("dashboard/health").expect(200)).body.presence).toHaveLength(2)
    await db.query(
      "UPDATE private.operator_presence SET last_seen_at=now()-interval '91 seconds' WHERE user_id=$1",
      [member]
    )
    expect((await get("dashboard/health").expect(200)).body.presence).toEqual([
      { user_id: actor, display_name: "Admin" },
    ])
    expect(
      result.body.schedules.find((row: { task: string }) => row.task === "process")
    ).toMatchObject({ owner: "paused", legacy_enabled: null, nest_enabled: null })
    expect(result.body.recent_runs).toHaveLength(2)
    expect(
      result.body.ingestion.reduce((n: number, row: { imported: number }) => n + row.imported, 0)
    ).toBe(3)
    expect(
      result.body.schedules.find((row: { task: string }) => row.task === "process-tag-queue")
    ).toMatchObject({ legacy_enabled: false, nest_enabled: false, owner: "paused" })
    expect(JSON.stringify(result.body)).not.toMatch(/fixture-model|operator@example|sk_test/)
    await db.query("UPDATE private.operator_presence SET last_seen_at=now()-interval '91 seconds'")
    await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [actor])
    await get("dashboard/health").expect(403)
  })
  it("rehearses presence rollback and reapplication without changing personal or configuration data", async () => {
    await get("dashboard/health").expect(200)
    await db.query(
      readFileSync("schema/migrations/20261008007000_operator_presence_down.sql", "utf8")
    )
    expect(
      (await db.query("SELECT to_regclass('private.operator_presence') AS table_name"))[0]!
        .table_name
    ).toBeNull()
    expect(await db.query("SELECT model_id FROM public.ai_feature_config")).toEqual([
      { model_id: "fixture-model" },
    ])
    await db.query("DROP TABLE IF EXISTS private.operator_presence")
    await db.query(readFileSync("schema/migrations/20261008007000_operator_presence.sql", "utf8"))
    await get("dashboard/health").expect(200)
  })
})
