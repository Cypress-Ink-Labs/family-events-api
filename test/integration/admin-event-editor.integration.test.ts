import { randomUUID } from "node:crypto"

import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { AdminUpdateEventInput } from "../../src/admin/admin-event-editor.input.js"
import { AdminEventEditorRepository } from "../../src/admin/admin-event-editor.repository.js"
import { AdminEventEditorService } from "../../src/admin/admin-event-editor.service.js"
import type { DbService } from "../../src/db/db.service.js"

import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

let db: DbService
let repository: AdminEventEditorRepository
let service: AdminEventEditorService
let actor: string

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  repository = new AdminEventEditorRepository(db)
  service = new AdminEventEditorService(repository)
})
afterAll(async () => {
  await db.onModuleDestroy()
})
beforeEach(async () => {
  await truncateAdminCatalog(db)
  actor = randomUUID()
  await db.query("INSERT INTO auth.users (id) VALUES ($1::uuid)", [actor])
  await db.query("INSERT INTO public.user_profiles (id, role) VALUES ($1::uuid, 'admin')", [actor])
  await db.query("INSERT INTO public.user_access (user_id, is_enabled) VALUES ($1::uuid, true)", [
    actor,
  ])
})

async function event(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = {
    id: randomUUID(),
    title: "Library story time",
    description: "Songs and stories",
    start_datetime: "2026-09-10T10:00:00.123456Z",
    created_at: "2026-09-01T10:00:00.123456Z",
    ...overrides,
  }
  const keys = Object.keys(row)
  await db.query(
    `INSERT INTO public.events (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row)
  )
  return row.id
}

async function tag(name: string): Promise<string> {
  const id = randomUUID()
  await db.query("INSERT INTO public.tags (id, name, slug, color) VALUES ($1, $2, $3, $4)", [
    id,
    name,
    name.toLowerCase().replaceAll(" ", "-"),
    "#123456",
  ])
  return id
}

function update(
  patch: AdminUpdateEventInput["patch"],
  tagIds: string[],
  overrides: Partial<AdminUpdateEventInput> = {}
): AdminUpdateEventInput {
  return {
    patch,
    tagIds,
    lockEditedFields: true,
    decisionReason: null,
    ...overrides,
  }
}

describe("admin event editor reads", () => {
  it("returns exact numerics, microsecond timestamps, assigned tags, and all choices", async () => {
    const selected = await tag("Storytime")
    const available = await tag("Outdoors")
    const id = await event({
      latitude: "30.1234567",
      longitude: "-91.7654321",
      price: "12.34",
    })
    await db.query(
      `INSERT INTO public.event_tags (event_id, tag_id, confidence, is_manual_override)
       VALUES ($1, $2, 0.876, false)`,
      [id, selected]
    )
    const detail = await service.get(actor, id)
    expect(detail.event).toMatchObject({
      id,
      latitude: "30.1234567",
      longitude: "-91.7654321",
      price: "12.34",
    })
    expect(detail.event.start_datetime).toContain(".123456")
    expect(detail.tags).toEqual([
      expect.objectContaining({
        id: selected,
        confidence: "0.876",
        is_manual_override: false,
      }),
    ])
    expect(detail.availableTags.map((row) => row.id).toSorted()).toEqual(
      [selected, available].toSorted()
    )
  })

  it("returns 404 for a missing event but 403 for disabled or expired database access", async () => {
    await expect(service.get(actor, randomUUID())).rejects.toBeInstanceOf(NotFoundException)
    const id = await event()
    await db.query("UPDATE public.user_access SET is_enabled = false WHERE user_id = $1", [actor])
    await expect(service.get(actor, id)).rejects.toBeInstanceOf(ForbiddenException)
    await db.query(
      `UPDATE public.user_access
       SET is_enabled = true, access_expires_at = now() - interval '1 second'
       WHERE user_id = $1`,
      [actor]
    )
    await expect(service.get(actor, id)).rejects.toBeInstanceOf(ForbiddenException)
  })
})

describe("admin event editor writes", () => {
  it("updates nullable fields, replaces tags, locks only patch fields, and attributes audit records", async () => {
    const oldTag = await tag("Old")
    const newTag = await tag("New")
    const id = await event()
    await db.query(
      "INSERT INTO public.event_tags (event_id, tag_id, confidence) VALUES ($1, $2, 0.5)",
      [id, oldTag]
    )
    const detail = await service.update(
      actor,
      id,
      update(
        {
          description: null,
          venueName: "Main Library",
          endDatetime: "2026-09-10T12:00:00.654321Z",
          price: null,
        },
        [newTag],
        { decisionReason: "Corrected listing" }
      )
    )
    expect(detail.event).toMatchObject({
      description: null,
      venue_name: "Main Library",
      price: null,
      admin_last_edited_by: actor,
      admin_locked_fields: ["description", "end_datetime", "price", "venue_name"],
    })
    expect(detail.event.end_datetime).toContain(".654321")
    expect(detail.tags).toEqual([
      expect.objectContaining({
        id: newTag,
        confidence: "1.000",
        is_manual_override: true,
      }),
    ])
    const audits = await db.query<{
      admin_user_id: string
      action: string
      metadata: {
        patch: Record<string, unknown>
        previous_tag_ids: string[]
        new_tag_ids: string[]
      }
    }>(
      `SELECT admin_user_id, action, metadata
       FROM public.admin_audit_log
       WHERE target_id = $1
       ORDER BY created_at`,
      [id]
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      admin_user_id: actor,
      action: "event.update",
      metadata: {
        patch: {
          description: null,
          venue_name: "Main Library",
          end_datetime: "2026-09-10T12:00:00.654321Z",
          price: null,
        },
        previous_tag_ids: [oldTag],
        new_tag_ids: [newTag],
      },
    })
    const decisions = await db.query<{
      admin_user_id: string
      decision_type: string
      reason: string
      old_tags: Array<{ tag_id: string }>
      new_tags: Array<{ tag_id: string }>
    }>(
      `SELECT admin_user_id, decision_type, reason, old_tags, new_tags
       FROM public.admin_event_decisions
       WHERE event_id = $1`,
      [id]
    )
    expect(decisions).toEqual([
      expect.objectContaining({
        admin_user_id: actor,
        decision_type: "tag_edit",
        reason: "Corrected listing",
        old_tags: [expect.objectContaining({ tag_id: oldTag })],
        new_tags: [expect.objectContaining({ tag_id: newTag })],
      }),
    ])
  })

  it("supports explicit empty tags and lock suppression without changing existing locks", async () => {
    const selected = await tag("Selected")
    const id = await event({ admin_locked_fields: ["title"] })
    await db.query("INSERT INTO public.event_tags (event_id, tag_id) VALUES ($1, $2)", [
      id,
      selected,
    ])
    const detail = await service.update(
      actor,
      id,
      update({ venueName: null }, [], { lockEditedFields: false })
    )
    expect(detail.event.admin_locked_fields).toEqual(["title"])
    expect(detail.tags).toEqual([])
  })

  it("serializes concurrent patches without losing either field or audit attribution", async () => {
    const id = await event()
    const [first, second] = await Promise.all([
      service.update(actor, id, update({ description: "First writer" }, [])),
      service.update(actor, id, update({ venueName: "Second writer" }, [])),
    ])
    expect([first.event.id, second.event.id]).toEqual([id, id])
    const detail = await service.get(actor, id)
    expect(detail.event).toMatchObject({
      description: "First writer",
      venue_name: "Second writer",
      admin_locked_fields: ["description", "venue_name"],
    })
    const audits = await db.query<{ admin_user_id: string }>(
      "SELECT admin_user_id FROM public.admin_audit_log WHERE target_id = $1",
      [id]
    )
    expect(audits).toHaveLength(2)
    expect(audits.every((row) => row.admin_user_id === actor)).toBe(true)
  })

  it("audits same-value updates without creating a false decision", async () => {
    const selected = await tag("Selected")
    const id = await event()
    await db.query(
      `INSERT INTO public.event_tags (event_id, tag_id, confidence, is_manual_override)
       VALUES ($1, $2, 1, true)`,
      [id, selected]
    )
    await service.update(actor, id, update({ title: "Library story time" }, [selected]))
    expect(
      await db.query("SELECT id FROM public.admin_audit_log WHERE target_id = $1", [id])
    ).toHaveLength(1)
    expect(
      await db.query("SELECT id FROM public.admin_event_decisions WHERE event_id = $1", [id])
    ).toEqual([])
  })

  it("rolls back the event, tag replacement, and decisions when the audit insert fails", async () => {
    const oldTag = await tag("Old")
    const newTag = await tag("New")
    const id = await event()
    await db.query("INSERT INTO public.event_tags (event_id, tag_id) VALUES ($1, $2)", [id, oldTag])
    await db.query(`
      CREATE OR REPLACE FUNCTION public.reject_admin_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END; $$;
      CREATE TRIGGER reject_admin_audit
      BEFORE INSERT ON public.admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION public.reject_admin_audit()
    `)
    try {
      await expect(
        service.update(
          actor,
          id,
          update({ title: "Must roll back", status: "published" }, [newTag])
        )
      ).rejects.toMatchObject({ message: "audit failed" })
    } finally {
      await db.query("DROP TRIGGER reject_admin_audit ON public.admin_audit_log")
      await db.query("DROP FUNCTION public.reject_admin_audit()")
    }
    const detail = await service.get(actor, id)
    expect(detail.event).toMatchObject({ title: "Library story time", status: "draft" })
    expect(detail.tags.map((row) => row.id)).toEqual([oldTag])
    expect(
      await db.query("SELECT id FROM public.admin_event_decisions WHERE event_id = $1", [id])
    ).toEqual([])
  })

  it("rolls back event changes and tag deletion when a replacement tag does not exist", async () => {
    const oldTag = await tag("Old")
    const id = await event()
    await db.query("INSERT INTO public.event_tags (event_id, tag_id) VALUES ($1, $2)", [id, oldTag])
    await expect(
      service.update(actor, id, update({ title: "Must roll back" }, [randomUUID()]))
    ).rejects.toMatchObject({ code: "23503" })
    const detail = await service.get(actor, id)
    expect(detail.event.title).toBe("Library story time")
    expect(detail.tags.map((row) => row.id)).toEqual([oldTag])
    expect(
      await db.query("SELECT id FROM public.admin_audit_log WHERE target_id = $1", [id])
    ).toEqual([])
  })

  it("unlocks managed fields, attributes the audit, and reports missing events", async () => {
    const id = await event({ admin_locked_fields: ["title", "description"] })
    await expect(service.unlock(actor, id)).resolves.toBe(1)
    expect((await service.get(actor, id)).event.admin_locked_fields).toEqual([])
    expect(
      await db.query(
        "SELECT admin_user_id, action, metadata FROM public.admin_audit_log WHERE target_id = $1",
        [id]
      )
    ).toEqual([
      {
        admin_user_id: actor,
        action: "event.fields.unlock",
        metadata: { locked_fields_after: [] },
      },
    ])
    await expect(service.unlock(actor, randomUUID())).rejects.toBeInstanceOf(NotFoundException)
  })

  it("preserves production status trigger behavior and decision reason", async () => {
    const id = await event({
      llm_review_status: "succeeded",
      llm_review_decision: "approve",
      llm_review_confidence: "0.900",
      llm_review_reason: "AI approved",
      llm_review_flags: ["clear"],
      llm_reviewed_at: "2026-09-01T12:00:00Z",
    })
    await service.update(
      actor,
      id,
      update({ status: "published" }, [], { decisionReason: "Human approved" })
    )
    const rows = await db.query<{
      status: string
      llm_review_status: string
      llm_review_decision: string | null
      llm_review_reason: string | null
      llm_review_flags: string[]
    }>(
      `SELECT status, llm_review_status, llm_review_decision, llm_review_reason, llm_review_flags
       FROM public.events WHERE id = $1`,
      [id]
    )
    expect(rows).toEqual([
      {
        status: "published",
        llm_review_status: "not_required",
        llm_review_decision: "approve",
        llm_review_reason: "AI approved",
        llm_review_flags: ["clear"],
      },
    ])
    expect(
      await db.query(
        "SELECT decision_type, old_status, new_status, reason FROM public.admin_event_decisions WHERE event_id = $1",
        [id]
      )
    ).toEqual([
      {
        decision_type: "status_change",
        old_status: "draft",
        new_status: "published",
        reason: "Human approved",
      },
    ])
  })

  it("keeps transaction-local actors isolated across concurrent updates", async () => {
    const otherActor = randomUUID()
    await db.query("INSERT INTO auth.users (id) VALUES ($1::uuid)", [otherActor])
    await db.query("INSERT INTO public.user_profiles (id, role) VALUES ($1::uuid, 'admin')", [
      otherActor,
    ])
    await db.query("INSERT INTO public.user_access (user_id, is_enabled) VALUES ($1::uuid, true)", [
      otherActor,
    ])
    const first = await event()
    const second = await event()
    await Promise.all([
      service.update(actor, first, update({ description: "First" }, [])),
      service.update(otherActor, second, update({ description: "Second" }, [])),
    ])
    const rows = await db.query<{ target_id: string; admin_user_id: string }>(
      `SELECT target_id, admin_user_id
       FROM public.admin_audit_log
       WHERE target_id = ANY($1::uuid[])
       ORDER BY target_id`,
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
