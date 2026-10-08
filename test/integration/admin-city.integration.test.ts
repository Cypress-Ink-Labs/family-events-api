import { randomUUID } from "node:crypto"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthModule } from "../../src/auth/auth.module.js"
import { AdminCityController } from "../../src/admin/admin-city.controller.js"
import { AdminCityRepository } from "../../src/admin/admin-city.repository.js"
import { PgExceptionFilter } from "../../src/common/pg-exception.filter.js"
import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { ReferenceRepository } from "../../src/data/reference.repository.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { integrationDatabaseUrl } from "./db.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === "operator" || token === "member") return { sub: `user_${token}` }
    throw new Error("invalid fixture token")
  }),
}))
const cityInput = {
  name: "Lafayette",
  state: "LA",
  country: "US",
  slug: "lafayette",
  timezone: "America/Chicago",
}
describe("city administration HTTP", () => {
  let app: INestApplication
  let db: DbService
  let actor: string
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
      controllers: [AdminCityController],
      providers: [AdminCityRepository],
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
    const member = randomUUID()
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
  })
  const authed = () =>
    request(app.getHttpServer()).post("/v1/admin/cities").set("Authorization", "Bearer operator")
  it("creates legacy location fields with null coordinates and audited mapped actor", async () => {
    const response = await authed().send(cityInput).expect(201)
    expect(response.body).toMatchObject({
      ...cityInput,
      latitude: null,
      longitude: null,
      is_active: true,
    })
    const audit = await db.query(
      "SELECT admin_user_id,action,target_type,metadata FROM public.admin_audit_log WHERE target_id=$1",
      [response.body.id]
    )
    expect(audit).toMatchObject([
      {
        admin_user_id: actor,
        action: "create_city",
        target_type: "city",
        metadata: { after: { name: "Lafayette" } },
      },
    ])
    expect(await new ReferenceRepository(db).listCities()).toMatchObject([{ id: response.body.id }])
  })
  it("toggles active state without losing location data and changes discovery choices", async () => {
    const created = await authed().send(cityInput).expect(201)
    await db.query("UPDATE public.cities SET latitude=30.22,longitude=-92.02 WHERE id=$1", [
      created.body.id,
    ])
    const change = await request(app.getHttpServer())
      .put(`/v1/admin/cities/${created.body.id}/active`)
      .set("Authorization", "Bearer operator")
      .send({ is_active: false })
      .expect(200)
    expect(change.body).toMatchObject({
      name: "Lafayette",
      timezone: "America/Chicago",
      latitude: "30.22",
      longitude: "-92.02",
      is_active: false,
    })
    expect(await new ReferenceRepository(db).listCities()).toEqual([])
    const all = await request(app.getHttpServer())
      .get("/v1/admin/cities")
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(all.body).toHaveLength(1)
    await request(app.getHttpServer())
      .put(`/v1/admin/cities/${created.body.id}/active`)
      .set("Authorization", "Bearer operator")
      .send({ is_active: true })
      .expect(200)
    expect(await new ReferenceRepository(db).listCities()).toHaveLength(1)
    expect(
      (await db.query("SELECT action FROM public.admin_audit_log WHERE action='set_city_active'"))
        .length
    ).toBe(2)
  })
  it("preserves operator concealment and blocks database access revocation", async () => {
    await request(app.getHttpServer()).get("/v1/admin/cities").expect(401)
    await request(app.getHttpServer())
      .get("/v1/admin/cities")
      .set("Authorization", "Bearer invalid")
      .expect(401)
    await request(app.getHttpServer())
      .get("/v1/admin/cities")
      .set("Authorization", "Bearer member")
      .expect(404)
    await db.query("UPDATE public.user_profiles SET role='user' WHERE id=$1", [actor])
    await request(app.getHttpServer())
      .get("/v1/admin/cities")
      .set("Authorization", "Bearer operator")
      .expect(403)
    await db.query("UPDATE public.user_profiles SET role='admin' WHERE id=$1", [actor])
    await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [actor])
    await authed().send(cityInput).expect(403)
    expect(await db.query("SELECT id FROM public.cities")).toEqual([])
  })
  it("validates required fields, timezone, payload scope and active state", async () => {
    for (const body of [
      { ...cityInput, name: " " },
      { ...cityInput, slug: "" },
      { ...cityInput, timezone: "Not/AZone" },
      { ...cityInput, latitude: 30 },
      { ...cityInput, is_active: false },
    ])
      await authed().send(body).expect(400)
    const created = await authed().send(cityInput).expect(201)
    await request(app.getHttpServer())
      .put(`/v1/admin/cities/${created.body.id}/active`)
      .set("Authorization", "Bearer operator")
      .send({ is_active: "false" })
      .expect(400)
    await request(app.getHttpServer())
      .put(`/v1/admin/cities/${randomUUID()}/active`)
      .set("Authorization", "Bearer operator")
      .send({ is_active: false })
      .expect(404)
    await request(app.getHttpServer())
      .put("/v1/admin/cities/bad/active")
      .set("Authorization", "Bearer operator")
      .send({ is_active: false })
      .expect(400)
  })
  it("returns safe duplicate errors and rolls back writes when audit insertion fails", async () => {
    const created = await authed().send(cityInput).expect(201)
    const duplicate = await authed().send(cityInput).expect(409)
    expect(duplicate.body.message).toBe("record already exists")
    await db.query(
      "CREATE OR REPLACE FUNCTION private.reject_city_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$"
    )
    await db.query(
      "CREATE TRIGGER reject_city_audit BEFORE INSERT ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION private.reject_city_audit()"
    )
    try {
      await authed()
        .send({ ...cityInput, name: "Other", slug: "other" })
        .expect(500)
      await request(app.getHttpServer())
        .put(`/v1/admin/cities/${created.body.id}/active`)
        .set("Authorization", "Bearer operator")
        .send({ is_active: false })
        .expect(500)
    } finally {
      await db.query("DROP TRIGGER reject_city_audit ON public.admin_audit_log")
    }
    expect(await db.query("SELECT slug,is_active FROM public.cities")).toEqual([
      { slug: "lafayette", is_active: true },
    ])
  })
})
