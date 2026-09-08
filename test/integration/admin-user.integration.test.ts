import { randomUUID } from "node:crypto"

import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { AdminUserRepository } from "../../src/admin/admin-user.repository.js"
import { AdminUserService } from "../../src/admin/admin-user.service.js"
import type { DbService } from "../../src/db/db.service.js"

import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

let db: DbService
let service: AdminUserService
let actor: string

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  service = new AdminUserService(new AdminUserRepository(db))
})
afterAll(async () => db.onModuleDestroy())
beforeEach(async () => {
  await truncateAdminCatalog(db)
  actor = await user("admin", true, { email: "admin@example.com" })
})

async function user(
  role: "user" | "admin",
  enabled: boolean,
  profile: { email?: string; displayName?: string } = {}
): Promise<string> {
  const id = randomUUID()
  await db.query("INSERT INTO auth.users (id) VALUES ($1)", [id])
  await db.query(
    `INSERT INTO public.user_profiles (id, role, email, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, role, profile.email ?? null, profile.displayName ?? null]
  )
  await db.query(
    `INSERT INTO public.user_access (user_id, is_enabled, enabled_at)
     VALUES ($1, $2, CASE WHEN $2 THEN now() ELSE NULL END)`,
    [id, enabled]
  )
  return id
}

describe("admin user access", () => {
  it("lists access and profile fields with raw timestamps", async () => {
    const target = await user("user", false, {
      email: "parent@example.com",
      displayName: "Parent",
    })
    await db.query(
      `UPDATE public.user_access
       SET access_expires_at = '2026-09-09T10:00:00.123456Z',
           disabled_at = '2026-09-08T10:00:00.654321Z',
           disabled_reason = 'Paused'
       WHERE user_id = $1`,
      [target]
    )
    const rows = await service.list(actor)
    expect(rows.find((row) => row.user_id === target)).toMatchObject({
      email: "parent@example.com",
      display_name: "Parent",
      role: "user",
      is_enabled: false,
      disabled_reason: "Paused",
    })
    expect(rows.find((row) => row.user_id === target)!.access_expires_at).toContain(".123456")
    expect(rows.find((row) => row.user_id === target)!.disabled_at).toContain(".654321")
  })

  it("disables and enables a user with audit attribution and reason normalization", async () => {
    const target = await user("user", true)
    const disabled = await service.setAccess(actor, target, {
      isEnabled: false,
      disabledReason: "  policy violation  ",
    })
    expect(disabled).toMatchObject({
      user_id: target,
      is_enabled: false,
      disabled_reason: "policy violation",
    })
    expect(disabled.disabled_at).not.toBeNull()
    const enabled = await service.setAccess(actor, target, {
      isEnabled: true,
      disabledReason: "ignored",
    })
    expect(enabled).toMatchObject({
      user_id: target,
      is_enabled: true,
      disabled_at: null,
      disabled_reason: null,
    })
    expect(
      await db.query(
        "SELECT admin_user_id, action FROM public.admin_audit_log WHERE target_id = $1 ORDER BY created_at",
        [target]
      )
    ).toEqual([
      { admin_user_id: actor, action: "user_access.disable" },
      { admin_user_id: actor, action: "user_access.enable" },
    ])
  })

  it("blocks self-disable and reports missing access without writes", async () => {
    await expect(
      service.setAccess(actor, actor, { isEnabled: false, disabledReason: null })
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      service.setAccess(actor, randomUUID(), { isEnabled: true, disabledReason: null })
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(await db.query("SELECT id FROM public.admin_audit_log")).toEqual([])
  })

  it("returns stable database denial after access disablement", async () => {
    await db.query("UPDATE public.user_access SET is_enabled = false WHERE user_id = $1", [actor])
    await expect(service.list(actor)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("rolls back access changes when audit insertion fails", async () => {
    const target = await user("user", true)
    await db.query(`
      CREATE OR REPLACE FUNCTION public.reject_user_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END; $$;
      CREATE TRIGGER reject_user_audit BEFORE INSERT ON public.admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION public.reject_user_audit()
    `)
    try {
      await expect(
        service.setAccess(actor, target, { isEnabled: false, disabledReason: "blocked" })
      ).rejects.toMatchObject({ message: "audit failed" })
    } finally {
      await db.query("DROP TRIGGER reject_user_audit ON public.admin_audit_log")
      await db.query("DROP FUNCTION public.reject_user_audit()")
    }
    expect(
      await db.query(
        "SELECT is_enabled, disabled_reason FROM public.user_access WHERE user_id = $1",
        [target]
      )
    ).toEqual([{ is_enabled: true, disabled_reason: null }])
  })
})

describe("admin user deletion", () => {
  it("deletes a non-admin account through auth.users cascades and retains its audit snapshot", async () => {
    const target = await user("user", true, { email: "delete@example.com" })
    await service.delete(actor, target)
    expect(await db.query("SELECT id FROM auth.users WHERE id = $1", [target])).toEqual([])
    expect(await db.query("SELECT id FROM public.user_profiles WHERE id = $1", [target])).toEqual(
      []
    )
    expect(
      await db.query("SELECT user_id FROM public.user_access WHERE user_id = $1", [target])
    ).toEqual([])
    const audits = await db.query<{
      admin_user_id: string
      action: string
      metadata: { previous_profile: { email: string } }
    }>("SELECT admin_user_id, action, metadata FROM public.admin_audit_log WHERE target_id = $1", [
      target,
    ])
    expect(audits).toEqual([
      {
        admin_user_id: actor,
        action: "user.delete",
        metadata: expect.objectContaining({
          previous_profile: expect.objectContaining({ email: "delete@example.com" }),
        }),
      },
    ])
  })

  it("blocks self-delete, admin deletion, and missing users", async () => {
    const otherAdmin = await user("admin", true)
    await expect(service.delete(actor, actor)).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.delete(actor, otherAdmin)).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.delete(actor, randomUUID())).rejects.toBeInstanceOf(NotFoundException)
  })

  it("isolates concurrent actor attribution", async () => {
    const otherActor = await user("admin", true)
    const first = await user("user", true)
    const second = await user("user", true)
    await Promise.all([
      service.setAccess(actor, first, { isEnabled: false, disabledReason: null }),
      service.setAccess(otherActor, second, { isEnabled: false, disabledReason: null }),
    ])
    const rows = await db.query<{ target_id: string; admin_user_id: string }>(
      "SELECT target_id, admin_user_id FROM public.admin_audit_log WHERE target_id = ANY($1::uuid[])",
      [[first, second]]
    )
    expect(new Map(rows.map((row) => [row.target_id, row.admin_user_id]))).toEqual(
      new Map([
        [first, actor],
        [second, otherActor],
      ])
    )
  })
})
