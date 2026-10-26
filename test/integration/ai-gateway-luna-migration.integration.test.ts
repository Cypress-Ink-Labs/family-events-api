import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { AdminAiRepository } from "../../src/admin/admin-ai.repository.js"
import type { DbService } from "../../src/db/db.service.js"
import { ClassificationRepository } from "../../src/pipeline/classification/classification.repository.js"
import { resolveTagEventAiConfig } from "../../src/pipeline/classification/tag-event-config.js"
import { APPROVED_GATEWAY_MODELS, DEFAULT_GATEWAY_MODEL } from "../../src/pipeline/llm-gateway.js"
import { ensureAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

const sql = (name: string) => readFileSync(`schema/migrations/${name}.sql`, "utf8")
const gateway = sql("20261026001000_ai_gateway")
const gatewayRollback = sql("20261026001000_ai_gateway_down")
const forward = sql("20261026002000_ai_gateway_gpt_6_luna")
const rollback = sql("20261026002000_ai_gateway_gpt_6_luna_down")
const LUNA = "openai/gpt-6-luna"
const LUNA_FAST = "openai/gpt-6-luna-fast"

let db: DbService
let actor: string

const legacyAssignments = [
  { feature: "event-review", model_id: "gpt-5.4-mini", enabled: true },
  { feature: "parent-tips", model_id: "gpt-5.4-nano", enabled: false },
  { feature: "review-memory", model_id: "gpt-5.4-nano", enabled: false },
  { feature: "source-auto-reject", model_id: "qwen3:1.7b", enabled: false },
  { feature: "tag-memory", model_id: "gpt-5.4-nano", enabled: true },
  { feature: "tagging", model_id: "gpt-5.4-mini", enabled: true },
]
const gatewayAssignments = [
  { feature: "event-review", model_id: "spacexai/grok-4.3", enabled: true },
  { feature: "parent-tips", model_id: "spacexai/grok-4.20-non-reasoning", enabled: false },
  { feature: "review-memory", model_id: "spacexai/grok-4.20-non-reasoning", enabled: false },
  { feature: "source-auto-reject", model_id: "qwen3:1.7b", enabled: false },
  { feature: "tag-memory", model_id: "spacexai/grok-4.20-non-reasoning", enabled: true },
  { feature: "tagging", model_id: "spacexai/grok-4.20-non-reasoning", enabled: true },
]

const apply = (text: string) => db.withTransaction((client) => client.query(text))
const assignments = () =>
  db.query<{ feature: string; model_id: string; enabled: boolean }>(
    "SELECT feature,model_id,enabled FROM public.ai_feature_config ORDER BY feature"
  )
const modelIds = async () =>
  (await db.query<{ id: string }>("SELECT id FROM public.approved_ai_models ORDER BY id")).map(
    (row) => row.id
  )
const backupTable = async () =>
  (
    await db.query<{ name: string | null }>(
      "SELECT to_regclass('private.api_ai_gateway_luna_rollback')::text AS name"
    )
  )[0]!.name
const assign = (feature: string, modelId: string) =>
  db.query("UPDATE public.ai_feature_config SET model_id=$2 WHERE feature=$1", [feature, modelId])

beforeAll(async () => {
  db = createIntegrationDb()
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  END $$`)
})
afterAll(async () => db.onModuleDestroy())

// Production state after 20261026001000: legacy OpenAI rows moved to Grok,
// a self-hosted row left alone, and an operator's later Grok 4.3 choice.
beforeEach(async () => {
  await ensureAdminCatalog(db)
  await db.query(readFileSync("test/integration/sql/ai_feature_config.sql", "utf8"))
  await db.query(
    "DROP TABLE IF EXISTS private.ai_call_health, private.api_ai_gateway_rollback, private.api_ai_gateway_luna_rollback"
  )
  await db.query(`ALTER TABLE public.events ADD CONSTRAINT events_ai_tag_provider_check
    CHECK (ai_tag_provider IS NULL OR ai_tag_provider = ANY (ARRAY['openai'::text, 'ollama'::text, 'localai'::text]))`)
  await db.query(`INSERT INTO public.approved_ai_models(id,provider,display_name,cost_tier) VALUES
    ('gpt-5.4-mini','openai','GPT-5.4 mini','low'),
    ('gpt-5.4-nano','openai','GPT-5.4 nano','low'),
    ('qwen3:1.7b','ollama','Qwen3 1.7B','low')`)
  for (const row of legacyAssignments)
    await db.query(
      "INSERT INTO public.ai_feature_config(feature,model_id,enabled) VALUES($1,$2,$3)",
      [row.feature, row.model_id, row.enabled]
    )
  await apply(gateway)
  await assign("event-review", "spacexai/grok-4.3")
  expect(await assignments()).toEqual(gatewayAssignments)

  actor = randomUUID()
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [actor])
  await db.query("INSERT INTO public.user_profiles(id,role) VALUES($1,'admin')", [actor])
  await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES($1,true)", [actor])
})

it("approves GPT-6 Luna, assigns it to all six features and keeps flags and other models selectable", async () => {
  await apply(forward)

  expect(await assignments()).toEqual(
    gatewayAssignments.map(({ feature, enabled }) => ({ feature, model_id: LUNA, enabled }))
  )
  const repository = new AdminAiRepository(db)
  const { models } = await repository.settings(actor)
  expect(models.filter((model) => model.provider === "gateway")).toEqual([
    {
      id: LUNA,
      provider: "gateway",
      display_name: "GPT-6 Luna",
      description: "Default. Efficient OpenAI reasoning model through the Vercel AI Gateway.",
      cost_tier: "low",
    },
    {
      id: LUNA_FAST,
      provider: "gateway",
      display_name: "GPT-6 Luna (fast)",
      description: "Faster GPT-6 Luna through the Vercel AI Gateway at twice the token price.",
      cost_tier: "low",
    },
    {
      id: "spacexai/grok-4.20-non-reasoning",
      provider: "gateway",
      display_name: "Grok 4.20 (fast)",
      description: "Fast non-reasoning Grok through the Vercel AI Gateway.",
      cost_tier: "low",
    },
    expect.objectContaining({ id: "spacexai/grok-4.3" }),
    expect.objectContaining({ id: "spacexai/grok-4.7" }),
  ])
  expect(new Set(models.filter((m) => m.provider === "gateway").map((m) => m.id))).toEqual(
    APPROVED_GATEWAY_MODELS
  )

  const tagging = await new ClassificationRepository(db).loadTagFeatureConfig()
  expect(tagging).toEqual({ modelId: DEFAULT_GATEWAY_MODEL, provider: "gateway", enabled: true })
  vi.stubEnv("AI_GATEWAY_API_KEY", "vck_fixture")
  vi.stubEnv("AI_PROVIDER", "")
  try {
    expect(resolveTagEventAiConfig(tagging)).toMatchObject({
      provider: "gateway",
      model: LUNA,
      configured: true,
    })
  } finally {
    vi.unstubAllEnvs()
  }

  for (const model_id of [LUNA_FAST, "spacexai/grok-4.7", "spacexai/grok-4.3", "qwen3:1.7b"])
    expect(await repository.update(actor, "tagging", { model_id, enabled: false })).toMatchObject({
      feature: "tagging",
      model_id,
      enabled: false,
    })
})

it("rolls back to the saved assignments, reapplies identically and unwinds the gateway migration", async () => {
  const before = await modelIds()
  await apply(forward)
  const migrated = await assignments()
  await apply(rollback)

  expect(await assignments()).toEqual(gatewayAssignments)
  expect(await modelIds()).toEqual(before)
  expect(await backupTable()).toBeNull()
  expect(
    await db.query(
      "SELECT description FROM public.approved_ai_models WHERE id='spacexai/grok-4.20-non-reasoning'"
    )
  ).toEqual([{ description: "Default. Fast non-reasoning Grok through the Vercel AI Gateway." }])

  await apply(forward)
  expect(await assignments()).toEqual(migrated)
  await apply(rollback)
  await apply(gatewayRollback)
  expect(await assignments()).toEqual(legacyAssignments)
})

it("keeps later operator choices and blocks rollback while a feature still uses GPT-6 Luna", async () => {
  await apply(forward)
  await assign("tagging", "spacexai/grok-4.7")
  await assign("parent-tips", LUNA_FAST)

  await expect(apply(rollback)).rejects.toThrow(
    "gpt-6-luna rollback blocked: a feature uses a GPT-6 Luna model with no saved assignment"
  )
  expect(await backupTable()).toBe("private.api_ai_gateway_luna_rollback")
  expect(await modelIds()).toContain(LUNA_FAST)
  expect((await assignments()).find((row) => row.feature === "event-review")?.model_id).toBe(LUNA)

  await assign("parent-tips", "spacexai/grok-4.20-non-reasoning")
  await apply(rollback)
  expect(await assignments()).toEqual(
    gatewayAssignments.map((row) =>
      row.feature === "tagging" ? { ...row, model_id: "spacexai/grok-4.7" } : row
    )
  )
  expect(await modelIds()).not.toContain(LUNA)
})

it("sees an assignment committed while rollback waits for its lock and stays blocked", async () => {
  await apply(forward)
  const writer = await db.pool.connect()
  const recovery = await db.pool.connect()
  try {
    await writer.query("BEGIN")
    await writer.query("UPDATE public.ai_feature_config SET model_id=$1 WHERE feature='tagging'", [
      LUNA_FAST,
    ])
    await recovery.query("BEGIN")
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid
    const recoveryPid = (await recovery.query("SELECT pg_backend_pid() AS pid")).rows[0].pid
    const result = recovery.query(rollback).then(
      () => null,
      (error: Error) => error
    )
    await expect
      .poll(
        async () =>
          (
            await db.query<{ blocked: boolean }>(
              "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
              [writerPid, recoveryPid]
            )
          )[0]!.blocked
      )
      .toBe(true)
    await writer.query("COMMIT")
    expect((await result)?.message).toMatch("gpt-6-luna rollback blocked")
    await recovery.query("ROLLBACK")
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined)
    await recovery.query("ROLLBACK").catch(() => undefined)
    writer.release()
    recovery.release()
  }
  expect((await assignments()).find((row) => row.feature === "tagging")?.model_id).toBe(LUNA_FAST)
  expect(await backupTable()).toBe("private.api_ai_gateway_luna_rollback")
})
