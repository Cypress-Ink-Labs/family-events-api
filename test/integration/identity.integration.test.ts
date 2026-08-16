import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { DbService } from "../../src/db/db.service.js"
import { createIntegrationDb } from "./db.js"
import { IdentityService } from "../../src/auth/identity.service.js"

/**
 * Mirrors the U19 migration DDL (20260816003000_clerk_user_mapping.sql),
 * including the auth.users FK and the shape/role check constraints,
 * against a real Postgres.
 */
describe("IdentityService (integration)", () => {
  let db: DbService
  let identity: IdentityService

  beforeAll(async () => {
    db = createIntegrationDb()
    await db.query("CREATE SCHEMA IF NOT EXISTS auth")
    await db.query("CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY)")
    await db.query(`CREATE TABLE IF NOT EXISTS public.clerk_user_mapping (
      clerk_user_id text PRIMARY KEY,
      supabase_uuid uuid NOT NULL UNIQUE REFERENCES auth.users (id) ON DELETE CASCADE,
      email text NOT NULL,
      role text NOT NULL DEFAULT 'member',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT clerk_user_mapping_clerk_id_shape_chk CHECK (clerk_user_id ~ '^user_'),
      CONSTRAINT clerk_user_mapping_role_chk CHECK (role IN ('operator', 'member'))
    )`)
    identity = new IdentityService(db)
  })

  beforeEach(async () => {
    await db.query("TRUNCATE public.clerk_user_mapping, auth.users CASCADE")
  })

  afterAll(async () => {
    await db.onModuleDestroy()
  })

  async function provision(clerkUserId: string, role: "operator" | "member"): Promise<string> {
    const uuid = randomUUID()
    await db.query("INSERT INTO auth.users (id) VALUES ($1)", [uuid])
    await db.query(
      "INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_uuid, email, role) VALUES ($1, $2, $3, $4)",
      [clerkUserId, uuid, `${clerkUserId}@example.com`, role]
    )
    return uuid
  }

  it("resolves a provisioned operator", async () => {
    const uuid = await provision("user_op1", "operator")
    expect(await identity.resolve("user_op1")).toEqual({
      clerkUserId: "user_op1",
      supabaseUuid: uuid,
      email: "user_op1@example.com",
      role: "operator",
    })
  })

  it("returns null for an unprovisioned Clerk user", async () => {
    expect(await identity.resolve("user_ghost")).toBeNull()
  })

  it("enforces the clerk id shape check from the migration", async () => {
    const uuid = randomUUID()
    await db.query("INSERT INTO auth.users (id) VALUES ($1)", [uuid])
    await expect(
      db.query(
        "INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_uuid, email) VALUES ($1, $2, $3)",
        ["not-a-clerk-id", uuid, "x@example.com"]
      )
    ).rejects.toThrow(/clerk_user_mapping_clerk_id_shape_chk/)
  })

  it("cascades mapping deletion when the auth user is removed (U7 precondition)", async () => {
    const uuid = await provision("user_gone", "member")
    await db.query("DELETE FROM auth.users WHERE id = $1", [uuid])
    expect(await identity.resolve("user_gone")).toBeNull()
  })
})
