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

describe("admin invite requests", () => {
  async function createRequest(email: string, createdAt?: string) {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO public.invite_requests (email, message, created_at)
       VALUES ($1, 'Please invite me', coalesce($2::timestamptz, now()))
       RETURNING id`,
      [email, createdAt ?? null]
    )
    return rows[0]!.id
  }

  it("defaults to pending semantics and lists filtered history deterministically", async () => {
    const older = await createRequest("older@example.com", "2026-09-01T00:00:00Z")
    const newer = await createRequest("newer@example.com", "2026-09-02T00:00:00Z")
    await service.rejectRequest(actor, older, { notes: "  Outside area  " })

    expect((await service.listRequests(actor, "pending")).map((row) => row.id)).toEqual([newer])
    expect((await service.listRequests(actor, "rejected")).map((row) => row.id)).toEqual([older])
    expect((await service.listRequests(actor, "all")).map((row) => row.id)).toEqual([newer, older])
  })

  it("approves once, links one hash-only code, and audits no plaintext or hash", async () => {
    const id = await createRequest("approve@example.com")
    const approved = await service.approveRequest(actor, id)
    expect(approved.code).toMatch(/^[A-HJ-NP-Z2-9]{24}$/)
    const stored = await db.query<{
      status: string
      invite_code_id: string
      reviewed_by: string
      code_hash: string
      max_uses: number
      expires_at: string | null
    }>(
      `SELECT r.status, r.invite_code_id, r.reviewed_by,
              c.code_hash, c.max_uses, c.expires_at
       FROM public.invite_requests r
       JOIN public.invite_codes c ON c.id = r.invite_code_id
       WHERE r.id = $1`,
      [id]
    )
    expect(stored[0]).toMatchObject({
      status: "approved",
      invite_code_id: approved.invite_code_id,
      reviewed_by: actor,
      max_uses: 1,
      expires_at: null,
    })
    const audit = await db.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM public.admin_audit_log WHERE action = 'invite_request.approve'"
    )
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain(approved.code)
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain(stored[0]!.code_hash)
    await expect(service.approveRequest(actor, id)).rejects.toBeInstanceOf(NotFoundException)
  })

  it("serializes concurrent approval so exactly one code and audit are created", async () => {
    const id = await createRequest("concurrent@example.com")
    const results = await Promise.allSettled([
      service.approveRequest(actor, id),
      service.approveRequest(actor, id),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await db.query("SELECT id FROM public.invite_codes")).toHaveLength(1)
    expect(
      await db.query(
        "SELECT id FROM public.admin_audit_log WHERE action = 'invite_request.approve'"
      )
    ).toHaveLength(1)
  })

  it("normalizes rejection notes and conceals a second review", async () => {
    const id = await createRequest("reject@example.com")
    await service.rejectRequest(actor, id, { notes: "  Outside area  " })
    expect(
      await db.query(
        "SELECT status, admin_notes, reviewed_by, reviewed_at IS NOT NULL AS reviewed FROM public.invite_requests WHERE id = $1",
        [id]
      )
    ).toEqual([
      { status: "rejected", admin_notes: "Outside area", reviewed_by: actor, reviewed: true },
    ])
    expect(
      await db.query(
        "SELECT admin_user_id, metadata FROM public.admin_audit_log WHERE action = 'invite_request.reject'"
      )
    ).toEqual([
      {
        admin_user_id: actor,
        metadata: { notes: "Outside area" },
      },
    ])
    await expect(service.rejectRequest(actor, id, {})).rejects.toBeInstanceOf(NotFoundException)
  })

  it("keeps approval and rejection successful when notification dispatch fails", async () => {
    await db.query("INSERT INTO private.test_email_dispatch_failure (enabled) VALUES (true)")
    const approvedId = await createRequest("email-fail-approve@example.com")
    const rejectedId = await createRequest("email-fail-reject@example.com")
    await expect(service.approveRequest(actor, approvedId)).resolves.toBeDefined()
    await expect(service.rejectRequest(actor, rejectedId, {})).resolves.toBeUndefined()
  })

  it("rolls back request review and generated code when API audit fails", async () => {
    const id = await createRequest("audit-fail@example.com")
    await db.query(`
      CREATE OR REPLACE FUNCTION public.reject_request_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'request audit failed'; END; $$;
      CREATE TRIGGER reject_request_audit BEFORE INSERT ON public.admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION public.reject_request_audit()
    `)
    try {
      await expect(service.approveRequest(actor, id)).rejects.toThrow("request audit failed")
    } finally {
      await db.query("DROP TRIGGER reject_request_audit ON public.admin_audit_log")
      await db.query("DROP FUNCTION public.reject_request_audit()")
    }
    expect(
      await db.query("SELECT status, invite_code_id FROM public.invite_requests WHERE id = $1", [
        id,
      ])
    ).toEqual([{ status: "pending", invite_code_id: null }])
    expect(await db.query("SELECT id FROM public.invite_codes")).toEqual([])
  })
})
