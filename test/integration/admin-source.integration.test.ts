import { randomUUID } from "node:crypto"

import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type {
  AdminCreateSourceInput,
  AdminSourcePatch,
} from "../../src/admin/admin-source.input.js"
import { AdminSourceRepository } from "../../src/admin/admin-source.repository.js"
import { AdminSourceService } from "../../src/admin/admin-source.service.js"
import type { DbService } from "../../src/db/db.service.js"
import type { JobsService } from "../../src/jobs/jobs.service.js"

import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

let db: DbService
let repository: AdminSourceRepository
let service: AdminSourceService
let actor: string

const CREATE_INPUT: AdminCreateSourceInput = {
  name: "Library Calendar",
  url: "https://example.com/events",
  sourceType: "website",
  extractionMode: "deterministic_then_llm",
  processingMode: "llm_review",
  cityId: null,
  isActive: true,
  scrapeIntervalHours: 12,
  notes: "Public calendar",
  dateWindowDays: 45,
}

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  repository = new AdminSourceRepository(db)
  service = new AdminSourceService(repository, { send: async () => null } as unknown as JobsService)
})
afterAll(async () => {
  await db.onModuleDestroy()
})
beforeEach(async () => {
  await truncateAdminCatalog(db)
  actor = await createAdmin()
})

async function createAdmin(): Promise<string> {
  const id = randomUUID()
  await db.query("INSERT INTO auth.users (id) VALUES ($1::uuid)", [id])
  await db.query("INSERT INTO public.user_profiles (id, role) VALUES ($1::uuid, 'admin')", [id])
  await db.query("INSERT INTO public.user_access (user_id, is_enabled) VALUES ($1::uuid, true)", [
    id,
  ])
  return id
}

async function city(): Promise<string> {
  const id = randomUUID()
  await db.query(
    "INSERT INTO public.cities (id, name, slug, timezone) VALUES ($1::uuid, 'Source City', $1::text, 'America/Chicago')",
    [id]
  )
  return id
}

async function source(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = {
    id: randomUUID(),
    name: "Source",
    url: `https://example.com/${randomUUID()}`,
    processing_mode: "manual_review",
    ...overrides,
  }
  const keys = Object.keys(row)
  await db.query(
    `INSERT INTO public.event_sources (${keys.join(", ")})
     VALUES (${keys.map((_, index) => `$${index + 1}`).join(", ")})`,
    Object.values(row)
  )
  return row.id
}

describe("admin source reads and access", () => {
  it("lists status and scheduling metadata with raw microsecond timestamps", async () => {
    const older = await source({
      name: "Older",
      created_at: "2026-09-01T10:00:00.123456Z",
      last_scraped_at: "2026-09-01T11:00:00.654321Z",
      last_status: "stale",
      error_count: 4,
      scrape_interval_hours: 6,
      date_window_days: 30,
      consecutive_zero_result_scrapes: 3,
      stale_escalated_at: "2026-09-01T12:00:00.111111Z",
    })
    const newer = await source({
      name: "Newer",
      created_at: "2026-09-02T10:00:00.123456Z",
      processing_mode: "auto_approve",
      auto_approve: true,
    })
    const rows = await service.list(actor)
    expect(rows.map((row) => row.id)).toEqual([newer, older])
    expect(rows[1]).toMatchObject({
      last_status: "stale",
      error_count: 4,
      scrape_interval_hours: 6,
      date_window_days: 30,
      consecutive_zero_result_scrapes: 3,
    })
    expect(rows[1]!.last_scraped_at).toContain(".654321")
    expect(rows[1]!.stale_escalated_at).toContain(".111111")
  })

  it("returns a stable 403 when database access is disabled or expired", async () => {
    await db.query("UPDATE public.user_access SET is_enabled = false WHERE user_id = $1", [actor])
    await expect(service.list(actor)).rejects.toBeInstanceOf(ForbiddenException)
    await db.query(
      `UPDATE public.user_access
       SET is_enabled = true, access_expires_at = now() - interval '1 second'
       WHERE user_id = $1`,
      [actor]
    )
    await expect(service.list(actor)).rejects.toBeInstanceOf(ForbiddenException)
  })
})

describe("admin source create and update", () => {
  it("creates a source and applies its requested processing mode atomically", async () => {
    const cityId = await city()
    const created = await service.create(actor, {
      ...CREATE_INPUT,
      cityId,
      processingMode: "auto_approve",
    })
    expect(created).toMatchObject({
      name: "Library Calendar",
      url: "https://example.com/events",
      source_type: "website",
      extraction_mode: "deterministic_then_llm",
      processing_mode: "auto_approve",
      auto_approve: true,
      city_id: cityId,
      is_active: true,
      scrape_interval_hours: 12,
      notes: "Public calendar",
      date_window_days: 45,
      last_status: "pending",
      error_count: 0,
    })
    const audits = await db.query<{
      admin_user_id: string
      action: string
      target_id: string
    }>(
      `SELECT admin_user_id, action, target_id
       FROM public.admin_audit_log
       WHERE target_id = $1
       ORDER BY created_at, action`,
      [created.id]
    )
    expect(audits).toEqual([
      { admin_user_id: actor, action: "source.create", target_id: created.id },
      {
        admin_user_id: actor,
        action: "source.processing_mode.update",
        target_id: created.id,
      },
    ])
  })

  it("rolls back creation and its first audit when processing-mode application fails", async () => {
    await db.query(`
      CREATE OR REPLACE FUNCTION public.reject_source_mode_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'source.processing_mode.update' THEN
          RAISE EXCEPTION 'mode audit failed';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_source_mode_audit
      BEFORE INSERT ON public.admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION public.reject_source_mode_audit()
    `)
    try {
      await expect(service.create(actor, CREATE_INPUT)).rejects.toMatchObject({
        message: "mode audit failed",
      })
    } finally {
      await db.query("DROP TRIGGER reject_source_mode_audit ON public.admin_audit_log")
      await db.query("DROP FUNCTION public.reject_source_mode_audit()")
    }
    expect(await db.query("SELECT id FROM public.event_sources")).toEqual([])
    expect(await db.query("SELECT id FROM public.admin_audit_log")).toEqual([])
  })

  it("preserves omitted fields, applies explicit nulls, and attributes the update audit", async () => {
    const id = await source({ notes: "Remove me", date_window_days: 14, is_active: true })
    const patch: AdminSourcePatch = { notes: null, dateWindowDays: null, isActive: false }
    const updated = await service.update(actor, id, patch)
    expect(updated).toMatchObject({
      id,
      name: "Source",
      notes: null,
      date_window_days: null,
      is_active: false,
    })
    expect(
      await db.query(
        "SELECT admin_user_id, action, metadata->'patch' AS patch FROM public.admin_audit_log WHERE target_id = $1",
        [id]
      )
    ).toEqual([
      {
        admin_user_id: actor,
        action: "source.update",
        patch: { notes: null, date_window_days: null, is_active: false },
      },
    ])
  })

  it("serializes concurrent partial updates without losing either field", async () => {
    const id = await source()
    await Promise.all([
      service.update(actor, id, { name: "Renamed" }),
      service.update(actor, id, { notes: "Added concurrently" }),
    ])
    const rows = await db.query<{ name: string; notes: string }>(
      "SELECT name, notes FROM public.event_sources WHERE id = $1",
      [id]
    )
    expect(rows).toEqual([{ name: "Renamed", notes: "Added concurrently" }])
    expect(
      await db.query("SELECT id FROM public.admin_audit_log WHERE target_id = $1", [id])
    ).toHaveLength(2)
  })

  it("rolls back a source update when its audit insert fails", async () => {
    const id = await source({ notes: "Original" })
    await db.query(`
      CREATE OR REPLACE FUNCTION public.reject_source_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END; $$;
      CREATE TRIGGER reject_source_audit
      BEFORE INSERT ON public.admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION public.reject_source_audit()
    `)
    try {
      await expect(service.update(actor, id, { notes: "Changed" })).rejects.toMatchObject({
        message: "audit failed",
      })
    } finally {
      await db.query("DROP TRIGGER reject_source_audit ON public.admin_audit_log")
      await db.query("DROP FUNCTION public.reject_source_audit()")
    }
    expect(await db.query("SELECT notes FROM public.event_sources WHERE id = $1", [id])).toEqual([
      { notes: "Original" },
    ])
  })

  it("returns 404 for missing sources and related cities", async () => {
    await expect(service.update(actor, randomUUID(), { notes: null })).rejects.toBeInstanceOf(
      NotFoundException
    )
    await expect(
      service.create(actor, { ...CREATE_INPUT, cityId: randomUUID() })
    ).rejects.toMatchObject({ code: "23503" })
  })
})

describe("admin source processing modes", () => {
  it.each([
    ["manual_review", false],
    ["auto_approve", true],
    ["llm_review", false],
  ] as const)("sets %s and keeps auto_approve synchronized", async (mode, autoApprove) => {
    const id = await source({ processing_mode: "manual_review", auto_approve: false })
    const updated = await service.setProcessingMode(actor, id, mode)
    expect(updated).toMatchObject({
      id,
      processing_mode: mode,
      auto_approve: autoApprove,
    })
    expect(
      await db.query(
        "SELECT admin_user_id, action, metadata FROM public.admin_audit_log WHERE target_id = $1",
        [id]
      )
    ).toEqual([
      {
        admin_user_id: actor,
        action: "source.processing_mode.update",
        metadata: {
          previous_processing_mode: "manual_review",
          processing_mode: mode,
          previous_auto_approve: false,
          auto_approve: autoApprove,
        },
      },
    ])
  })

  it("updates every source and records the exact affected count", async () => {
    const first = await source()
    const second = await source({ is_active: false })
    await service.bulkSetProcessingMode(actor, "auto_approve")
    const rows = await db.query<{ id: string; processing_mode: string; auto_approve: boolean }>(
      "SELECT id, processing_mode, auto_approve FROM public.event_sources ORDER BY id"
    )
    expect(rows.map((row) => row.id).toSorted()).toEqual([first, second].toSorted())
    expect(rows.every((row) => row.processing_mode === "auto_approve" && row.auto_approve)).toBe(
      true
    )
    expect(
      await db.query(
        "SELECT admin_user_id, action, metadata FROM public.admin_audit_log WHERE action = 'bulk_set_processing_mode'"
      )
    ).toEqual([
      {
        admin_user_id: actor,
        action: "bulk_set_processing_mode",
        metadata: { processing_mode: "auto_approve", affected_count: 2 },
      },
    ])
  })

  it("returns 404 for a missing single source", async () => {
    await expect(
      service.setProcessingMode(actor, randomUUID(), "manual_review")
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe("admin source durable scrape queue", () => {
  it("deduplicates concurrent scrape-now requests and preserves bigint queue IDs", async () => {
    const id = await source({ last_status: "error" })
    await db.query("ALTER SEQUENCE public.source_scrape_queue_id_seq RESTART WITH 9007199254740993")
    const [first, second] = await Promise.all([
      service.scrape(actor, id),
      service.scrape(actor, id),
    ])
    expect(first).toEqual({ queueId: "9007199254740993", deduped: false })
    expect(second).toEqual({ queueId: "9007199254740993", deduped: true })
    expect(
      await db.query(
        "SELECT id::text, source_id, trigger_type, status FROM public.source_scrape_queue"
      )
    ).toEqual([
      {
        id: "9007199254740993",
        source_id: id,
        trigger_type: "manual",
        status: "pending",
      },
    ])
    expect(
      await db.query("SELECT last_status FROM public.event_sources WHERE id = $1", [id])
    ).toEqual([{ last_status: "pending" }])
  })

  it("rejects inactive sources and conceals missing sources without queue writes", async () => {
    const inactive = await source({ is_active: false })
    await expect(service.scrape(actor, inactive)).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.scrape(actor, randomUUID())).rejects.toBeInstanceOf(NotFoundException)
    expect(await db.query("SELECT id FROM public.source_scrape_queue")).toEqual([])
  })

  it("retains a queued run while nulling its source reference after source deletion", async () => {
    const id = await source()
    const queued = await service.scrape(actor, id)
    await db.query("DELETE FROM public.event_sources WHERE id = $1", [id])
    expect(
      await db.query("SELECT id::text, source_id FROM public.source_scrape_queue WHERE id = $1", [
        queued.queueId,
      ])
    ).toEqual([{ id: queued.queueId, source_id: null }])
  })

  it("keeps transaction-local actor attribution isolated across concurrent mode updates", async () => {
    const otherActor = await createAdmin()
    const first = await source()
    const second = await source()
    await Promise.all([
      service.setProcessingMode(actor, first, "llm_review"),
      service.setProcessingMode(otherActor, second, "auto_approve"),
    ])
    const rows = await db.query<{ target_id: string; admin_user_id: string }>(
      `SELECT target_id, admin_user_id
       FROM public.admin_audit_log
       WHERE target_id = ANY($1::uuid[])`,
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
