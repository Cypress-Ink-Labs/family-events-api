import { afterEach, describe, expect, it, vi } from "vitest"

import { IngestionRepository } from "./ingestion.repository.js"

afterEach(() => vi.unstubAllEnvs())

it("sends an API-owned tag drain to pg-boss instead of the legacy Edge dispatcher", async () => {
  vi.stubEnv("NODE_ENV", "production")
  vi.stubEnv("CUTOVER_TAG", "true")
  const query = vi.fn(async () => [])
  const send = vi.fn(async () => "queued")
  const getGateState = vi.fn(async () => ({ legacyEnabled: false, nestEnabled: true }))
  const repository = new IngestionRepository(
    { query } as never,
    { send } as never,
    { getGateState } as never
  )

  await repository.invokeProcessTagQueue()

  expect(send).toHaveBeenCalledWith(
    "tag",
    { task: "drain-tag-queue" },
    { singletonKey: "drain-tag-queue" }
  )
  expect(getGateState).toHaveBeenCalledWith("cron-tag-queue")
  expect(query).not.toHaveBeenCalled()
})

it("retains the legacy kick while that executor still owns tagging", async () => {
  vi.stubEnv("NODE_ENV", "production")
  vi.stubEnv("CUTOVER_TAG", "false")
  const query = vi.fn(async (_text: string) => [])
  const send = vi.fn()
  const repository = new IngestionRepository(
    { query } as never,
    { send } as never,
    { getGateState: async () => ({ legacyEnabled: true, nestEnabled: false }) } as never
  )
  await repository.invokeProcessTagQueue()
  expect(query).toHaveBeenCalledOnce()
  expect(query.mock.calls[0]?.[0]).toContain("public.invoke_process_tag_queue()")
  expect(send).not.toHaveBeenCalled()
})

it.each([
  { enabled: false, flag: "true" },
  { enabled: true, flag: "false" },
  { enabled: true, flag: undefined },
  { enabled: true, flag: "TRUE" },
])(
  "dispatches no executor when the API is paused or uninstalled ($enabled, $flag)",
  async ({ enabled, flag }) => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("CUTOVER_TAG", flag)
    const query = vi.fn(async () => [])
    const send = vi.fn()
    const repository = new IngestionRepository(
      { query } as never,
      { send } as never,
      { getGateState: async () => ({ legacyEnabled: false, nestEnabled: enabled }) } as never
    )
    await repository.invokeProcessTagQueue()
    expect(query).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  }
)

it("does not fall back to the legacy Edge executor when pg-boss rejects the API kick", async () => {
  vi.stubEnv("NODE_ENV", "production")
  vi.stubEnv("CUTOVER_TAG", "true")
  const query = vi.fn(async () => [])
  const repository = new IngestionRepository(
    { query } as never,
    {
      send: async () => {
        throw new Error("broker unavailable")
      },
    } as never,
    { getGateState: async () => ({ legacyEnabled: false, nestEnabled: true }) } as never
  )
  await expect(repository.invokeProcessTagQueue()).rejects.toThrow("broker unavailable")
  expect(query).not.toHaveBeenCalled()
})

it("fails closed when ownership cannot be read", async () => {
  const query = vi.fn(async () => [])
  const send = vi.fn()
  const repository = new IngestionRepository(
    { query } as never,
    { send } as never,
    {
      getGateState: async () => {
        throw new Error("gate unavailable")
      },
    } as never
  )
  await expect(repository.invokeProcessTagQueue()).rejects.toThrow("gate unavailable")
  expect(query).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

describe("IngestionRepository", () => {
  it("imports event rows and their family-needs evidence in one transaction", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ result: { imported: 1, updated: 0, skipped: 0, enqueued: 1 } }],
        })
        .mockResolvedValueOnce({ rows: [{ import_family_need_statements: 1 }] }),
    }
    const withTransaction = vi.fn(async (run: (transaction: typeof client) => Promise<unknown>) =>
      run(client)
    )
    const repository = new IngestionRepository(
      { withTransaction } as never,
      {} as never,
      {} as never
    )
    const events = [
      {
        title: "Accessible storytime",
        family_need_statements: [
          {
            claim: "wheelchair_accessible",
            value: "supported",
            statement: "Wheelchair accessible",
          },
        ],
      },
    ]

    await expect(repository.bulkImportScrapeEvents("run-id", "source-id", events)).resolves.toEqual(
      {
        imported: 1,
        updated: 0,
        skipped: 0,
        enqueued: 1,
      }
    )
    expect(withTransaction).toHaveBeenCalledOnce()
    expect(client.query).toHaveBeenCalledTimes(2)
    expect(client.query.mock.calls[0]?.[1]).toEqual(["run-id", "source-id", JSON.stringify(events)])
    expect(client.query.mock.calls[1]?.[1]).toEqual(["source-id", JSON.stringify(events)])
  })
})
