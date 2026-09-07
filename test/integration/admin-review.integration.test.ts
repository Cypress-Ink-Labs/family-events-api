import { randomUUID } from "node:crypto"

import { NotFoundException } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { parseAdminEventsQuery } from "../../src/admin/admin-review.input.js"
import { AdminReviewRepository } from "../../src/admin/admin-review.repository.js"
import { AdminReviewService } from "../../src/admin/admin-review.service.js"
import type { DbService } from "../../src/db/db.service.js"

import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

let db: DbService
let repository: AdminReviewRepository
let service: AdminReviewService
let actor: string

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  repository = new AdminReviewRepository(db)
  service = new AdminReviewService(repository)
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
    status: "draft",
    start_datetime: "2026-09-10T10:00:00.123456Z",
    created_at: "2026-09-01T10:00:00.123456Z",
    ...overrides,
  }
  const keys = Object.keys(row)
  // Keys are test-owned fixture overrides, values remain query parameters.
  await db.query(
    `INSERT INTO public.events (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row)
  )
  return row.id
}

function page(query: Record<string, string> = {}) {
  return service.listEvents(actor, parseAdminEventsQuery(query))
}

async function city(): Promise<string> {
  const id = randomUUID()
  await db.query(
    "INSERT INTO public.cities (id, name, slug, timezone) VALUES ($1::uuid, 'Library City', $1::text, 'America/Chicago')",
    [id]
  )
  return id
}

async function source(): Promise<string> {
  const id = randomUUID()
  await db.query(
    "INSERT INTO public.event_sources (id, name, url) VALUES ($1, 'Library Calendar', $2)",
    [id, `https://example.com/${id}`]
  )
  return id
}

describe("admin review RPC reads", () => {
  it("combines status, city, source, LLM status/decision/reviewed and keyword filters", async () => {
    const cityId = await city()
    const sourceId = await source()
    const selected = await event({
      city_id: cityId,
      source_id: sourceId,
      status: "published",
      llm_review_status: "succeeded",
      llm_review_decision: "approve",
      llm_reviewed_at: "2026-09-01T11:00:00Z",
      ai_confidence: "0.12345678901234567890123456789",
    })
    await event({ status: "rejected", city_id: cityId })
    await event({
      llm_review_status: "failed",
      llm_review_decision: "approve",
      llm_reviewed_at: "2026-09-01T11:00:00Z",
    })
    await event()

    const result = await page({
      status: "published",
      city_id: cityId,
      city_is_null: "false",
      source_id: sourceId,
      keyword: "library story",
      llm_review_status: "succeeded",
      llm_review_decision: "approve",
      llm_reviewed: "true",
    })
    expect(result.events.map((row) => row.id)).toEqual([selected])
    expect(result.totalCount).toBe(1)
    expect(result.events[0]).toMatchObject({
      source_id: sourceId,
      ai_confidence: "0.12345678901234567890123456789",
    })
    expect(result.events[0]!.start_datetime).toContain(".123456")
    expect((await page({ city_is_null: "true" })).totalCount).toBe(2)
    expect((await page({ city_is_null: "false" })).totalCount).toBe(2)
    expect((await page({ llm_reviewed: "true" })).totalCount).toBe(1)
    // Legacy false means no reviewed-only restriction, including reviewed rows.
    expect((await page({ llm_reviewed: "false" })).totalCount).toBe(4)
    expect((await page({ city_id: cityId, city_is_null: "true" })).totalCount).toBe(0)
  })

  it.each(["%", "_", "\\"])("matches literal %s in list and facets", async (keyword) => {
    const id = await event({ title: `Literal ${keyword} marker` })
    await event({ title: "Unrelated other marker" })
    expect((await page({ keyword })).events.map((row) => row.id)).toEqual([id])
    expect(await service.facets(actor, keyword)).toEqual([
      { city_id: null, source_id: null, status: "draft", count: 1 },
    ])
  })

  it("orders tied microsecond timestamps by descending UUID without losing rows", async () => {
    const low = "00000000-0000-4000-8000-000000000001"
    const high = "00000000-0000-4000-8000-000000000002"
    await event({ id: low })
    await event({ id: high })
    const later = await event({ created_at: "2026-09-01T10:00:00.123457Z" })
    const first = await page({ limit: "2" })
    expect(first.events.map((row) => row.id)).toEqual([later, high])
    expect(first.nextCursor).toEqual({ afterCreatedAt: first.events[1]!.created_at, afterId: high })
    expect(first.nextCursor!.afterCreatedAt).toContain(".123456")
    const next = await page({
      limit: "2",
      after_created_at: first.nextCursor!.afterCreatedAt,
      after_id: high,
    })
    expect(next.events.map((row) => row.id)).toEqual([low])
    expect(next.nextCursor).toBeNull()
    expect(next.totalCount).toBe(3)
  })

  it("reports no cursor for an exactly full last page and counts an empty cursor page with identical filters", async () => {
    const cityId = await city()
    const sourceId = await source()
    const matching = {
      city_id: cityId,
      source_id: sourceId,
      status: "published",
      llm_review_status: "succeeded",
      llm_review_decision: "approve",
      llm_reviewed_at: "2026-09-01T11:00:00Z",
    }
    await event(matching)
    await event(matching)
    await event({ title: "Unrelated", status: "rejected" })
    const filters = {
      status: "published",
      city_id: cityId,
      city_is_null: "false",
      source_id: sourceId,
      keyword: "library",
      llm_review_status: "succeeded",
      llm_review_decision: "approve",
      llm_reviewed: "true",
      limit: "2",
    }
    const full = await page(filters)
    expect(full.events).toHaveLength(2)
    expect(full.nextCursor).toBeNull()
    const last = full.events.at(-1)!
    const empty = await page({ ...filters, after_created_at: last.created_at, after_id: last.id })
    expect(empty).toEqual({ events: [], totalCount: 2, nextCursor: null })
  })

  it("probes beyond the RPC's 500-row clamp and distinguishes exactly 500 rows", async () => {
    await db.query(`INSERT INTO public.events (title, start_datetime, created_at)
      SELECT 'Large review queue', now(), '2026-09-01T00:00:00Z'::timestamptz + g * interval '1 microsecond'
      FROM generate_series(1, 501) g`)
    const full = await page({ limit: "500" })
    expect(full.events).toHaveLength(500)
    expect(full.totalCount).toBe(501)
    expect(full.nextCursor).not.toBeNull()
    const final = await page({
      limit: "500",
      after_created_at: full.nextCursor!.afterCreatedAt,
      after_id: full.nextCursor!.afterId,
    })
    expect(final.events).toHaveLength(1)
    expect(final.nextCursor).toBeNull()
    await service.bulkDelete(actor, [final.events[0]!.id])
    const exactlyFull = await page({ limit: "500" })
    expect(exactlyFull.events).toHaveLength(500)
    expect(exactlyFull.totalCount).toBe(500)
    expect(exactlyFull.nextCursor).toBeNull()
  })

  it("groups facets by city, source and status, with safe numeric bigint counts", async () => {
    const cityId = await city()
    const sourceId = await source()
    await event({ city_id: cityId, source_id: sourceId })
    await event({ city_id: cityId, source_id: sourceId })
    await event({ city_id: cityId, source_id: sourceId, status: "published" })
    await event()
    await event({ title: "Unrelated" })
    const facets = await service.facets(actor, "library")
    expect(facets).toHaveLength(3)
    expect(facets).toEqual(
      expect.arrayContaining([
        { city_id: cityId, source_id: sourceId, status: "draft", count: 2 },
        { city_id: cityId, source_id: sourceId, status: "published", count: 1 },
        { city_id: null, source_id: null, status: "draft", count: 1 },
      ])
    )
    expect(facets.reduce((sum, row) => sum + row.count, 0)).toBe(
      (await page({ keyword: "library" })).totalCount
    )
    expect(await service.facets(actor, "absent")).toEqual([])
  })
})

describe("admin review RPC writes", () => {
  it("attributes status edits, captures decisions only on change, and audits same-status actions", async () => {
    const sourceId = await source()
    const id = await event({ source_id: sourceId, source_name: "Library Calendar" })
    expect(await service.setStatus(actor, id, "published", "Reviewed")).toBe(1)
    const [stored] = await db.query<Record<string, unknown>>(
      "SELECT * FROM public.events WHERE id = $1",
      [id]
    )
    expect(stored).toMatchObject({ status: "published", admin_last_edited_by: actor })
    expect(stored!.admin_last_edited_at).not.toBeNull()
    expect(
      await db.query(
        "SELECT admin_user_id, decision_type, old_status, new_status, reason, source_context FROM public.admin_event_decisions"
      )
    ).toEqual([
      {
        admin_user_id: actor,
        decision_type: "status_change",
        old_status: "draft",
        new_status: "published",
        reason: "Reviewed",
        source_context: { source_id: sourceId, source_name: "Library Calendar" },
      },
    ])
    expect(await service.setStatus(actor, id, "published", null)).toBe(1)
    expect(
      await db.query("SELECT count(*)::int AS count FROM public.admin_event_decisions")
    ).toEqual([{ count: 1 }])
    const logs = await db.query<Record<string, unknown>>(
      "SELECT * FROM public.admin_audit_log ORDER BY created_at"
    )
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({
      admin_user_id: actor,
      action: "event.status_change",
      target_id: id,
      metadata: { old_status: "draft", new_status: "published", reason: "Reviewed" },
    })
    expect(logs[1]).toMatchObject({
      metadata: { old_status: "published", new_status: "published", reason: null },
    })
    expect(
      await db.query("SELECT nullif(current_setting('request.jwt.claims', true), '') AS claims")
    ).toEqual([{ claims: null }])
    await expect(service.setStatus(actor, randomUUID(), "draft", null)).rejects.toBeInstanceOf(
      NotFoundException
    )
  })

  it("batch updates unique existing IDs atomically and preserves the legacy batch audit", async () => {
    const first = await event()
    const second = await event()
    const missing = randomUUID()
    expect(await service.bulkStatus(actor, [first, first, second, missing], "rejected")).toBe(2)
    expect(await db.query("SELECT status, admin_last_edited_by FROM public.events")).toEqual([
      { status: "rejected", admin_last_edited_by: actor },
      { status: "rejected", admin_last_edited_by: actor },
    ])
    const [log] = await db.query<Record<string, unknown>>("SELECT * FROM public.admin_audit_log")
    expect(log).toMatchObject({
      admin_user_id: actor,
      action: "event.status.batch_update",
      metadata: { affected_count: 2, status: "rejected" },
    })
    expect((log!.metadata as { previous: unknown[] }).previous).toHaveLength(2)
    expect(
      await db.query("SELECT count(*)::int AS count FROM public.admin_event_decisions")
    ).toEqual([{ count: 0 }])
    expect(await service.bulkStatus(actor, [missing], "archived")).toBe(0)
    await db.query(
      `ALTER TABLE public.admin_audit_log ADD CONSTRAINT reject_batch_audit CHECK (action <> 'event.status.batch_update') NOT VALID`
    )
    try {
      await expect(service.bulkStatus(actor, [first, second], "archived")).rejects.toMatchObject({
        code: "23514",
      })
      expect(await db.query("SELECT DISTINCT status FROM public.events")).toEqual([
        { status: "rejected" },
      ])
    } finally {
      await db.query("ALTER TABLE public.admin_audit_log DROP CONSTRAINT reject_batch_audit")
    }
  })

  it("deletes once per existing ID, cascades child rows, and retains attributed snapshots", async () => {
    const id = await event()
    const tag = randomUUID()
    await db.query("INSERT INTO public.tags (id, name, slug) VALUES ($1, 'Free', 'free')", [tag])
    await db.query("INSERT INTO public.event_tags (event_id, tag_id) VALUES ($1, $2)", [id, tag])
    await db.query("INSERT INTO public.favorites (event_id, user_id) VALUES ($1, $2)", [id, actor])
    await db.query("INSERT INTO public.user_calendar_events (event_id, user_id) VALUES ($1, $2)", [
      id,
      actor,
    ])
    await db.query("INSERT INTO public.ratings (event_id, user_id, score) VALUES ($1, $2, 5)", [
      id,
      actor,
    ])
    await db.query(
      "INSERT INTO public.comments (event_id, user_id, body) VALUES ($1, $2, 'Useful')",
      [id, actor]
    )
    await db.query("INSERT INTO public.event_tag_queue (event_id) VALUES ($1)", [id])
    await db.query(
      "INSERT INTO public.event_ai_traces (event_id, input_title) VALUES ($1, 'Library')",
      [id]
    )
    const [queue] = await db.query<{ id: string }>(
      "INSERT INTO public.event_llm_review_queue (event_id) VALUES ($1) RETURNING id",
      [id]
    )
    await db.query(
      "INSERT INTO public.event_llm_review_traces (event_id, queue_id, prompt_version, status) VALUES ($1, $2, 'v1', 'succeeded')",
      [id, queue!.id]
    )
    await service.setStatus(actor, id, "published", null)
    expect(await service.bulkDelete(actor, [id, id, randomUUID()])).toBe(1)
    for (const table of [
      "events",
      "event_tags",
      "favorites",
      "user_calendar_events",
      "ratings",
      "comments",
      "event_tag_queue",
      "event_ai_traces",
      "event_llm_review_queue",
      "event_llm_review_traces",
      "admin_event_decisions",
    ]) {
      expect(await db.query(`SELECT count(*)::int AS count FROM public.${table}`)).toEqual([
        { count: 0 },
      ])
    }
    const [log] = await db.query<Record<string, unknown>>(
      "SELECT * FROM public.admin_audit_log WHERE action = 'event.delete'"
    )
    expect(log).toMatchObject({
      admin_user_id: actor,
      action: "event.delete",
      metadata: {
        affected_count: 1,
        previous: [
          expect.objectContaining({ id, title: "Library story time", status: "published" }),
        ],
      },
    })
    expect(await service.bulkDelete(actor, [id, randomUUID()])).toBe(0)
  })

  it.each(["expired", "missing", "disabled", "member"])(
    "conceals %s DB access for every operation",
    async (denial) => {
      const id = await event()
      if (denial === "expired")
        await db.query(
          "UPDATE public.user_access SET access_expires_at = now() - interval '1 second'"
        )
      if (denial === "missing") await db.query("DELETE FROM public.user_access")
      if (denial === "disabled") await db.query("UPDATE public.user_access SET is_enabled = false")
      if (denial === "member") await db.query("UPDATE public.user_profiles SET role = 'user'")
      for (const run of [
        () => page(),
        () => service.facets(actor, null),
        () => service.setStatus(actor, id, "published", null),
        () => service.bulkStatus(actor, [id], "published"),
        () => service.bulkDelete(actor, [id]),
      ]) {
        await expect(run()).rejects.toBeInstanceOf(NotFoundException)
      }
      expect(await db.query("SELECT status FROM public.events")).toEqual([{ status: "draft" }])
      expect(await db.query("SELECT count(*)::int AS count FROM public.admin_audit_log")).toEqual([
        { count: 0 },
      ])
    }
  )
})
