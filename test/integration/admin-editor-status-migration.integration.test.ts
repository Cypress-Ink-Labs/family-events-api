import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest"
import { AdminEventEditorRepository } from "../../src/admin/admin-event-editor.repository.js"
import type { DbService } from "../../src/db/db.service.js"
import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

let db: DbService
let actor: string
let eventId: string
const typed =
  "status = CASE WHEN patch ? 'status' THEN (patch->>'status')::public.event_status ELSE status END"
const untyped = "status = CASE WHEN patch ? 'status' THEN patch->>'status' ELSE status END"
const forward = readFileSync(
  "schema/migrations/20261011001000_admin_editor_status_enum.sql",
  "utf8"
)
const rollback = readFileSync(
  "schema/migrations/20261011001000_admin_editor_status_enum_down.sql",
  "utf8"
)

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
})
afterAll(async () => db.onModuleDestroy())
beforeEach(async () => {
  await db.query("DROP TABLE IF EXISTS private.api_admin_editor_status_rollback")
  await truncateAdminCatalog(db)
  actor = randomUUID()
  eventId = randomUUID()
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [actor])
  await db.query("INSERT INTO public.user_profiles(id,role) VALUES($1,'admin')", [actor])
  await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES($1,true)", [actor])
  await db.query(
    "INSERT INTO public.events(id,title,start_datetime) VALUES($1,'Private draft','2026-10-25T15:30:12.123456Z')",
    [eventId]
  )
})

async function definition(): Promise<string> {
  const result = await db.query<{ definition: string }>(
    "SELECT pg_get_functiondef('private.admin_update_event(uuid,jsonb,uuid[],boolean,text)'::regprocedure) AS definition"
  )
  return result[0]!.definition
}

it("saves changed fields through the production legacy status expression", async () => {
  const original = await definition()
  expect(original).toContain(typed)
  await db.query(original.replace(typed, untyped))
  await db.withTransaction((client) => client.query(forward))
  const repository = new AdminEventEditorRepository(db)
  const saved = await repository.update(actor, eventId, {
    patch: { title: "Corrected private draft" },
    tagIds: [],
    lockEditedFields: true,
    decisionReason: null,
  })
  expect(saved.event).toMatchObject({ title: "Corrected private draft", status: "draft" })
  expect(saved.event.start_datetime).toContain(".123456")
  expect(saved.event.admin_locked_fields).toEqual(["title"])
  const rejected = await repository.update(actor, eventId, {
    patch: { status: "rejected" },
    tagIds: [],
    lockEditedFields: true,
    decisionReason: "Controlled rejection",
  })
  expect(rejected.event.status).toBe("rejected")
  expect(
    await db.query(
      "SELECT old_status,new_status,reason FROM public.admin_event_decisions WHERE event_id=$1",
      [eventId]
    )
  ).toEqual([{ old_status: "draft", new_status: "rejected", reason: "Controlled rejection" }])
  await db.withTransaction((client) => client.query(rollback))
  expect(await definition()).toBe(original.replace(typed, untyped))
})

it("preserves an already corrected definition through apply and rollback", async () => {
  const original = await definition()
  await db.query(original.replace(untyped, typed))
  const corrected = await definition()
  await db.withTransaction((client) => client.query(forward))
  expect(await definition()).toBe(corrected)
  await db.withTransaction((client) => client.query(rollback))
  expect(await definition()).toBe(corrected)
})

it("rejects unknown definitions atomically and protects subsequent function changes on rollback", async () => {
  const original = (await definition()).replace(untyped, typed)
  await db.query(original.replace(typed, "status = status"))
  await expect(db.withTransaction((client) => client.query(forward))).rejects.toThrow(
    "unknown assignment"
  )
  expect(
    (await db.query("SELECT to_regclass('private.api_admin_editor_status_rollback') AS name"))[0]!
      .name
  ).toBeNull()
  await db.query(original)
  await db.withTransaction((client) => client.query(forward))
  await db.query(original.replace("DECLARE", "DECLARE\n  future_variable text;"))
  await expect(db.withTransaction((client) => client.query(rollback))).rejects.toThrow(
    "function changed after migration"
  )
  expect(await definition()).toContain("future_variable text")
})
