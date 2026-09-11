import { randomUUID } from "node:crypto"

import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { AdminDeadLetterRepository } from "../../src/admin/admin-dead-letter.repository.js"
import { AdminDeadLetterService } from "../../src/admin/admin-dead-letter.service.js"
import { parseDeadLetterListQuery } from "../../src/admin/admin-dead-letter.input.js"
import type { DbService } from "../../src/db/db.service.js"

import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

let db: DbService
let service: AdminDeadLetterService
let actor: string
let sourceId: string
let eventId: string

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  service = new AdminDeadLetterService(new AdminDeadLetterRepository(db))
})
afterAll(async () => db.onModuleDestroy())
beforeEach(async () => {
  await truncateAdminCatalog(db)
  actor = randomUUID()
  sourceId = randomUUID()
  eventId = randomUUID()
  await db.query("INSERT INTO auth.users (id) VALUES ($1)", [actor])
  await db.query("INSERT INTO public.user_profiles (id, role) VALUES ($1, 'admin')", [actor])
  await db.query("INSERT INTO public.user_access (user_id, is_enabled) VALUES ($1, true)", [actor])
  await db.query("INSERT INTO public.event_sources (id, name, url) VALUES ($1, 'DLQ', $2)", [
    sourceId,
    `https://example.com/${sourceId}`,
  ])
  await db.query(
    "INSERT INTO public.events (id, title, start_datetime, status, source_id) VALUES ($1, 'DLQ', now(), 'draft', $2)",
    [eventId, sourceId]
  )
})

async function dead(
  queue: "source" | "tag",
  finishedAt: string | null,
  sourceRunId: string | null = randomUUID()
): Promise<string> {
  const table = queue === "source" ? "source_scrape_queue" : "event_tag_queue"
  const column = queue === "source" ? "source_id" : "event_id"
  const entity = queue === "source" ? sourceId : eventId
  const result = await db.query<{ id: string }>(
    `INSERT INTO public.${table}
       (${column}, source_run_id, status, attempt_count, finished_at, last_error)
     VALUES ($1, $2, 'dead', 4, $3, 'production failure')
     RETURNING id::text AS id`,
    [entity, sourceRunId, finishedAt]
  )
  return result[0]!.id
}

describe("admin dead letters on PostgreSQL", () => {
  it("authorizes before access and handles bigint IDs above Number.MAX_SAFE_INTEGER", async () => {
    await expect(
      service.list(randomUUID(), { queue: "source", limit: 10, cursor: null })
    ).rejects.toBeInstanceOf(ForbiddenException)
    await db.query(
      "SELECT setval(pg_get_serial_sequence('public.source_scrape_queue', 'id'), 9007199254740992)"
    )
    const id = await dead("source", "2026-06-01T00:00:00.123456Z")
    expect(id).toBe("9007199254740993")
    const page = await service.list(actor, { queue: "source", limit: 10, cursor: null })
    expect(page.items[0]).toMatchObject({
      id,
      queue: "source",
      enqueued_at: expect.any(String),
      source_run_id: expect.any(String),
    })
  })

  it("keyset-pages equal, non-null, and null finished_at without skips or duplicates", async () => {
    for (const timestamp of [
      "2026-06-03T00:00:00Z",
      "2026-06-02T00:00:00Z",
      "2026-06-02T00:00:00Z",
      null,
      null,
    ])
      await dead("tag", timestamp)
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const page = await service.list(actor, {
        queue: "tag",
        limit: 2,
        cursor:
          cursor === null
            ? null
            : parseDeadLetterListQuery({ queue: "tag", limit: "2", cursor }).cursor,
      })
      ids.push(...page.items.map((row) => row.id))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
  })

  it("source retry retains its dead row and tag retry removes its dead row", async () => {
    const sourceDead = await dead("source", new Date().toISOString())
    const tagDead = await dead("tag", new Date().toISOString())
    const sourceRetry = await service.retry(actor, "source", sourceDead)
    expect(sourceRetry).toMatchObject({
      disposition: "queued",
    })
    const tagRetry = await service.retry(actor, "tag", tagDead)
    expect(tagRetry).toMatchObject({ disposition: "queued" })
    expect(
      await db.query("SELECT status FROM public.source_scrape_queue WHERE id = $1", [sourceDead])
    ).toHaveLength(1)
    expect(
      await db.query("SELECT status FROM public.event_tag_queue WHERE id = $1", [tagDead])
    ).toHaveLength(0)
    const audits = await db.query<{ admin_user_id: string; metadata: Record<string, unknown> }>(
      `SELECT admin_user_id, metadata FROM public.admin_audit_log
       WHERE action = 'dead_letter.retry' ORDER BY metadata->>'queue'`
    )
    expect(audits).toHaveLength(2)
    expect(audits.every((audit) => audit.admin_user_id === actor)).toBe(true)
    expect(audits.map((audit) => audit.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queue: "source",
          original_id: sourceDead,
          resulting_queue_id: sourceRetry.resultingQueueId,
        }),
        expect.objectContaining({
          queue: "tag",
          original_id: tagDead,
          resulting_queue_id: tagRetry.resultingQueueId,
        }),
      ])
    )
  })

  it("returns already_active, rejects missing/nondead rows, and serializes concurrent retry", async () => {
    const deadId = await dead("source", new Date().toISOString())
    await db.query(
      "INSERT INTO public.source_scrape_queue (source_id, status) VALUES ($1, 'pending')",
      [sourceId]
    )
    await expect(service.retry(actor, "source", deadId)).resolves.toMatchObject({
      disposition: "already_active",
    })
    await expect(service.retry(actor, "source", deadId)).resolves.toMatchObject({
      disposition: "already_active",
    })
    await expect(service.retry(actor, "tag", "9223372036854775807")).rejects.toBeInstanceOf(
      NotFoundException
    )
    const pending = await db.query<{ id: string }>(
      "INSERT INTO public.event_tag_queue (event_id, status) VALUES ($1, 'pending') RETURNING id::text AS id",
      [eventId]
    )
    await expect(service.retry(actor, "tag", pending[0]!.id)).rejects.toBeInstanceOf(
      NotFoundException
    )
    const concurrentId = await dead("tag", new Date().toISOString())
    const outcomes = await Promise.allSettled([
      service.retry(actor, "tag", concurrentId),
      service.retry(actor, "tag", concurrentId),
    ])
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
  })

  it("deletes, attributes metadata to auth.uid(), and rolls audit back on failure", async () => {
    const id = await dead("source", new Date().toISOString())
    await service.remove(actor, "source", id)
    const audit = await db.query<{ admin_user_id: string; metadata: Record<string, unknown> }>(
      "SELECT admin_user_id::text, metadata FROM public.admin_audit_log WHERE action = 'dead_letter.delete'"
    )
    expect(audit[0]).toMatchObject({
      admin_user_id: actor,
      metadata: { queue: "source", original_id: id, old_error: "production failure" },
    })
    const rollbackId = await dead("tag", new Date().toISOString())
    await db.query(`
      CREATE OR REPLACE FUNCTION private.reject_dead_letter_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit rejected'; END $$;
      CREATE TRIGGER reject_dead_letter_audit BEFORE INSERT ON public.admin_audit_log
      FOR EACH ROW WHEN (NEW.action = 'dead_letter.delete') EXECUTE FUNCTION private.reject_dead_letter_audit()
    `)
    await expect(service.remove(actor, "tag", rollbackId)).rejects.toThrow("audit rejected")
    expect(
      await db.query("SELECT 1 FROM public.event_tag_queue WHERE id = $1", [rollbackId])
    ).toHaveLength(1)
  })
})
