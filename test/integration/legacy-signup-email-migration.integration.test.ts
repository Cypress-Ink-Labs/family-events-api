import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { DbService } from "../../src/db/db.service.js"
import { ensureAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

const clerkLifecycle = readFileSync("schema/migrations/20261008001000_clerk_lifecycle.sql", "utf8")
const forward = readFileSync(
  "schema/migrations/20261107002000_remove_signup_welcome_email.sql",
  "utf8"
)
const rollback = readFileSync(
  "schema/migrations/20261107002000_remove_signup_welcome_email_down.sql",
  "utf8"
)

let db: DbService
let previousDefinition: string

async function definition(): Promise<string> {
  const result = await db.query<{ definition: string }>(
    "SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) AS definition"
  )
  return result[0]!.definition
}

async function dispatched(): Promise<unknown[]> {
  const rows = await db.query<{ payload: unknown }>(
    "SELECT payload FROM private.signup_dispatch_calls"
  )
  return rows.map((row) => row.payload)
}

async function signUp(appMetaData: Record<string, string> | null): Promise<string> {
  const id = randomUUID()
  await db.query(
    "INSERT INTO auth.users(id,email,raw_app_meta_data,raw_user_meta_data) VALUES($1,$2,$3,$4)",
    [
      id,
      `${id}@example.com`,
      appMetaData && JSON.stringify(appMetaData),
      JSON.stringify({ display_name: "Chosen name" }),
    ]
  )
  return id
}

async function createdRows(id: string) {
  return {
    profile: await db.query("SELECT email,display_name FROM public.user_profiles WHERE id=$1", [
      id,
    ]),
    access: await db.query("SELECT is_enabled FROM public.user_access WHERE user_id=$1", [id]),
  }
}

beforeAll(async () => {
  db = createIntegrationDb()
  await db.query(
    "CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY); DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users"
  )
  await ensureAdminCatalog(db)
  await db.query(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text,
      ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
      ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb,
      ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb,
      ADD COLUMN IF NOT EXISTS created_at timestamptz,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz;
    CREATE TABLE IF NOT EXISTS private.signup_invites_required_fixture (require_invite boolean NOT NULL);
    TRUNCATE private.signup_invites_required_fixture;
    INSERT INTO private.signup_invites_required_fixture VALUES(false);
    CREATE OR REPLACE FUNCTION private.invites_required() RETURNS boolean LANGUAGE sql AS $$
      SELECT require_invite FROM private.signup_invites_required_fixture
    $$;
    CREATE TABLE IF NOT EXISTS private.signup_dispatch_calls (payload jsonb NOT NULL);
    CREATE OR REPLACE FUNCTION private.dispatch_email_notification(p_payload jsonb) RETURNS void
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO private.signup_dispatch_calls VALUES (p_payload);
    END;
    $$;
    DROP TRIGGER IF EXISTS tombstone_deleted_clerk_user ON auth.users;
    DROP FUNCTION IF EXISTS private.tombstone_deleted_clerk_user();
    DROP TABLE IF EXISTS private.clerk_user_lifecycle;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
  `)
  await db.query(clerkLifecycle)
  previousDefinition = await definition()
  await db.query(`CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()`)
})
afterAll(async () => {
  await db?.query("DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users")
  await db?.onModuleDestroy()
})
beforeEach(async () => {
  await db.query(previousDefinition)
  await db.query("UPDATE private.signup_invites_required_fixture SET require_invite=false")
  await db.query("TRUNCATE private.signup_dispatch_calls, auth.users CASCADE")
})

describe("handle_new_user without the legacy welcome email", () => {
  it("dispatches a welcome email for a non-Clerk signup before the migration", async () => {
    const id = await signUp(null)
    expect(await dispatched()).toEqual([
      { kind: "welcome", email: `${id}@example.com`, username: "Chosen name" },
    ])
  })

  it("creates the profile and access rows for a non-Clerk signup and dispatches nothing", async () => {
    await db.withTransaction((client) => client.query(forward))
    for (const appMetaData of [null, { provider: "google" }, { provider: "email" }]) {
      const id = await signUp(appMetaData)
      expect(await createdRows(id)).toEqual({
        profile: [{ email: `${id}@example.com`, display_name: "Chosen name" }],
        access: [{ is_enabled: true }],
      })
    }
    expect(await dispatched()).toEqual([])
  })

  it("keeps the invite gate for a non-Clerk signup", async () => {
    await db.withTransaction((client) => client.query(forward))
    await db.query("UPDATE private.signup_invites_required_fixture SET require_invite=true")
    const id = await signUp({ provider: "google" })
    expect((await createdRows(id)).access).toEqual([{ is_enabled: false }])
    expect(await dispatched()).toEqual([])
  })

  it("leaves a Clerk signup unchanged", async () => {
    await db.withTransaction((client) => client.query(forward))
    const id = await signUp({ provider: "clerk" })
    expect(await createdRows(id)).toEqual({
      profile: [{ email: `${id}@example.com`, display_name: "Chosen name" }],
      access: [{ is_enabled: true }],
    })
    expect(await dispatched()).toEqual([])
  })

  it("removes only the dispatch block from the function", async () => {
    await db.withTransaction((client) => client.query(forward))
    const updated = await definition()
    expect(updated).not.toContain("dispatch_email_notification")
    expect(updated.split("\n").every((line) => previousDefinition.includes(line))).toBe(true)
  })

  it("refuses to run twice because its anchor is gone", async () => {
    await db.withTransaction((client) => client.query(forward))
    await expect(db.withTransaction((client) => client.query(forward))).rejects.toThrow(
      "could not find the welcome email block"
    )
  })

  it("restores the previous function exactly on rollback", async () => {
    await db.withTransaction((client) => client.query(forward))
    await db.withTransaction((client) => client.query(rollback))
    expect(await definition()).toBe(previousDefinition)
    const id = await signUp({ provider: "google" })
    expect(await dispatched()).toEqual([
      { kind: "welcome", email: `${id}@example.com`, username: "Chosen name" },
    ])
  })
})
