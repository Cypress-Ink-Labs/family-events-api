import { describe, expect, it, vi } from "vitest"

import { IngestionRepository } from "./ingestion.repository.js"

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
    const repository = new IngestionRepository({ withTransaction } as never)
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
