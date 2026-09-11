import { randomUUID } from "node:crypto"

import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { AdminInviteRepository } from "../../src/admin/admin-invite.repository.js"
import { AdminInviteService } from "../../src/admin/admin-invite.service.js"
import type { DbService } from "../../src/db/db.service.js"

import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

let db: DbService
let service: AdminInviteService
let actor: string

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  service = new AdminInviteService(new AdminInviteRepository(db))
})
afterAll(async () => db.onModuleDestroy())
beforeEach(async () => {
  await truncateAdminCatalog(db)
  actor = randomUUID()
  await db.query("INSERT INTO auth.users (id) VALUES ($1)", [actor])
  await db.query(
    "INSERT INTO public.user_profiles (id, role, email) VALUES ($1, 'admin', 'admin@example.com')",
    [actor]
  )
  await db.query("INSERT INTO public.user_access (user_id, is_enabled) VALUES ($1, true)", [actor])
})

describe("admin invite codes", () => {
  it("uses the effective gate default and transaction-local override", async () => {
    await expect(service.required(actor)).resolves.toBe(false)
    await expect(
      db.withTransaction(async (client) => {
        await client.query("SELECT set_config('app.settings.require_invite', 'true', true)")
        const result = await client.query<{ required: boolean }>(
          "SELECT public.invites_required() AS required"
        )
        return result.rows[0]!.required
      })
    ).resolves.toBe(true)
  })

  it("returns plaintext once while persisting and auditing no plaintext or hash", async () => {
    const created = await service.createCode(actor, {
      maxUses: 2,
      expiresAt: "2026-10-08T00:00:00.123456Z",
      notes: "Family referral",
    })
    expect(created.code).toMatch(/^[A-HJ-NP-Z2-9]{24}$/)
    expect(created.created_at).toBeTypeOf("string")
    const stored = await db.query<{
      code_hash: string
      created_by: string
      expires_at: string
    }>("SELECT code_hash, created_by, expires_at FROM public.invite_codes WHERE id = $1", [
      created.id,
    ])
    expect(stored[0]!.code_hash).toHaveLength(64)
    expect(stored[0]!.code_hash).not.toContain(created.code)
    expect(stored[0]!.created_by).toBe(actor)
    expect(stored[0]!.expires_at).toContain(".123456")
    const audit = await db.query<{ admin_user_id: string; metadata: Record<string, unknown> }>(
      "SELECT admin_user_id, metadata FROM public.admin_audit_log WHERE target_id = $1",
      [created.id]
    )
    expect(audit[0]!.admin_user_id).toBe(actor)
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain(created.code)
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain(stored[0]!.code_hash)
    const listed = await service.listCodes(actor)
    expect(listed[0]).not.toHaveProperty("code")
    expect(listed[0]).not.toHaveProperty("code_hash")
  })

  it("revokes once, conceals the second attempt, and audits only success", async () => {
    const created = await service.createCode(actor, { maxUses: 1 })
    await expect(service.revokeCode(actor, created.id)).resolves.toBeUndefined()
    await expect(service.revokeCode(actor, created.id)).rejects.toBeInstanceOf(NotFoundException)
    expect(
      await db.query(
        "SELECT count(*)::int AS count FROM public.admin_audit_log WHERE action = 'invite_code.revoke'"
      )
    ).toEqual([{ count: 1 }])
  })

  it("rolls back create when API-side audit fails", async () => {
    await db.query(`
      CREATE OR REPLACE FUNCTION public.reject_invite_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END; $$;
      CREATE TRIGGER reject_invite_audit BEFORE INSERT ON public.admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION public.reject_invite_audit()
    `)
    try {
      await expect(service.createCode(actor, { maxUses: 1 })).rejects.toThrow("audit failed")
    } finally {
      await db.query("DROP TRIGGER reject_invite_audit ON public.admin_audit_log")
      await db.query("DROP FUNCTION public.reject_invite_audit()")
    }
    expect(await db.query("SELECT id FROM public.invite_codes")).toEqual([])
  })

  it("nulls created_by after the creating profile is deleted", async () => {
    const created = await service.createCode(actor, { maxUses: 1 })
    await db.query("DELETE FROM public.user_profiles WHERE id = $1", [actor])
    expect(
      await db.query("SELECT created_by FROM public.invite_codes WHERE id = $1", [created.id])
    ).toEqual([{ created_by: null }])
  })

  it("returns stable 403 after database access is disabled", async () => {
    await db.query("UPDATE public.user_access SET is_enabled = false WHERE user_id = $1", [actor])
    await expect(service.listCodes(actor)).rejects.toBeInstanceOf(ForbiddenException)
  })
})
