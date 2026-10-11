import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest"
import type { DbService } from "../../src/db/db.service.js"
import { AdminReviewRepository } from "../../src/admin/admin-review.repository.js"
import { parseAdminEventsQuery } from "../../src/admin/admin-review.input.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

let db: DbService
let actor: string
let baseline: string
const signature =
  "private.admin_events_enriched(text,uuid,boolean,text,timestamptz,uuid,integer,public.llm_event_review_status,public.llm_event_review_decision,boolean,uuid)"
const forward = readFileSync(
  "schema/migrations/20261011002000_admin_queue_count_materialization.sql",
  "utf8"
)
const rollback = readFileSync(
  "schema/migrations/20261011002000_admin_queue_count_materialization_down.sql",
  "utf8"
)

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  baseline = await definition()
})
afterAll(async () => db.onModuleDestroy())
beforeEach(async () => {
  await db.query("DROP TABLE IF EXISTS private.api_admin_queue_count_rollback")
  await db.query(baseline)
  await truncateAdminCatalog(db)
  actor = randomUUID()
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [actor])
  await db.query("INSERT INTO public.user_profiles(id,role) VALUES($1,'admin')", [actor])
  await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES($1,true)", [actor])
  await db.query(`INSERT INTO public.events(id,title,description,status,start_datetime,created_at)
    SELECT gen_random_uuid(), 'Queue event ' || i, repeat('Details ', 100),
      CASE WHEN i % 2 = 0 THEN 'draft'::public.event_status ELSE 'rejected'::public.event_status END,
      '2026-10-25T15:30:12.123456Z'::timestamptz,
      '2026-10-01T12:00:00.123456Z'::timestamptz + i * interval '1 microsecond'
    FROM generate_series(1,1000) i`)
})

async function definition() {
  return (
    await db.query<{ definition: string }>(
      "SELECT pg_get_functiondef($1::regprocedure) AS definition",
      [signature]
    )
  )[0]!.definition
}

interface PlanNode {
  "Node Type": string
  "Actual Loops": number
  Plans?: PlanNode[]
}

it("calculates the total once even when PostgreSQL chooses a generic queue plan", async () => {
  await db.withTransaction((client) => client.query(forward))
  const sql = (await definition())
    .split("RETURN QUERY")[1]!
    .split("END;")[0]!
    .trim()
    .replace(/;\s*$/, "")
  const names = [
    "p_status",
    "p_city_id",
    "p_city_is_null",
    "p_keyword",
    "p_after_created_at",
    "p_after_id",
    "p_limit",
    "p_llm_review_status",
    "p_llm_review_decision",
    "p_llm_reviewed",
    "p_source_id",
  ]
  const query = sql.replace(/\bp_[a-z_]+\b/g, (name) => `$${names.indexOf(name) + 1}`)
  const plan = await db.withTransaction(async (client) => {
    await client.query("SET LOCAL plan_cache_mode=force_generic_plan")
    await client.query(
      "PREPARE queue_count_plan(text,uuid,boolean,text,timestamptz,uuid,integer,public.llm_event_review_status,public.llm_event_review_decision,boolean,uuid) AS " +
        query
    )
    try {
      return (
        await client.query(
          "EXPLAIN (ANALYZE,FORMAT JSON) EXECUTE queue_count_plan(NULL,NULL,NULL,NULL,NULL,NULL,200,NULL,NULL,NULL,NULL)"
        )
      ).rows[0]["QUERY PLAN"][0].Plan as PlanNode
    } finally {
      await client.query("DEALLOCATE queue_count_plan")
    }
  })
  const aggregates: PlanNode[] = []
  const visit = (node: PlanNode) => {
    if (node["Node Type"] === "Aggregate") aggregates.push(node)
    node.Plans?.forEach(visit)
  }
  visit(plan)
  expect(aggregates).toHaveLength(1)
  expect(aggregates[0]!["Actual Loops"]).toBe(1)
})

it("preserves exact filtered counts, descending pages and cursor boundaries through the repository", async () => {
  await db.withTransaction((client) => client.query(forward))
  const repository = new AdminReviewRepository(db)
  const input = parseAdminEventsQuery({ status: "draft", limit: "200" })
  const first = await repository.listEvents(actor, input)
  expect(first).toHaveLength(200)
  expect(Number(first[0]!.total_count)).toBe(500)
  const expected = await db.query<{ id: string }>(
    "SELECT id FROM public.events WHERE status='draft' ORDER BY created_at DESC,id DESC"
  )
  expect(first.map((row) => row.id)).toEqual(expected.slice(0, 200).map((row) => row.id))
  const last = first.at(-1)!
  const next = await repository.listEvents(actor, {
    ...input,
    afterCreatedAt: last.created_at,
    afterId: last.id,
  })
  expect(next.map((row) => row.id)).toEqual(expected.slice(200, 400).map((row) => row.id))
  expect(Number(next[0]!.total_count)).toBe(500)
  await db.withTransaction((client) => client.query(rollback))
  expect(await definition()).toBe(baseline)
})

it("round trips an already materialized function without changing it", async () => {
  const corrected = baseline.replace("base_count AS (", "base_count AS MATERIALIZED (")
  await db.query(corrected)
  await db.withTransaction((client) => client.query(forward))
  expect(await definition()).toBe(corrected)
  await db.withTransaction((client) => client.query(rollback))
  expect(await definition()).toBe(corrected)
})

it("rejects unknown count definitions atomically and refuses to overwrite a later function change", async () => {
  await db.query(baseline.replace("base_count AS (", "base_count AS NOT MATERIALIZED ("))
  await expect(db.withTransaction((client) => client.query(forward))).rejects.toThrow(
    "unknown count expression"
  )
  expect(
    (await db.query("SELECT to_regclass('private.api_admin_queue_count_rollback') AS name"))[0]!
      .name
  ).toBeNull()
  await db.query(baseline)
  await db.withTransaction((client) => client.query(forward))
  const later = (await definition()).replace("BEGIN", "BEGIN\n  PERFORM 1;")
  await db.query(later)
  await expect(db.withTransaction((client) => client.query(rollback))).rejects.toThrow(
    "function changed after migration"
  )
  expect(await definition()).toBe(later)
})

it("preserves a concurrent function replacement committed while rollback waits", async () => {
  await db.withTransaction((client) => client.query(forward))
  const later = (await definition()).replace("BEGIN", "BEGIN\n  PERFORM 1;")
  const writer = await db.pool.connect()
  const recovery = await db.pool.connect()
  try {
    await writer.query("BEGIN")
    await writer.query(later)
    await recovery.query("BEGIN")
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid
    const recoveryPid = (await recovery.query("SELECT pg_backend_pid() AS pid")).rows[0].pid
    const result = recovery.query(rollback).then(
      () => ({ error: null }),
      (error: Error) => ({ error })
    )
    await expect
      .poll(async () => {
        const rows = await db.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [writerPid, recoveryPid]
        )
        return rows[0]!.blocked
      })
      .toBe(true)
    await writer.query("COMMIT")
    expect((await result).error).not.toBeNull()
    expect(await definition()).toBe(later)
  } finally {
    await writer.query("ROLLBACK")
    await recovery.query("ROLLBACK")
    writer.release()
    recovery.release()
  }
})
