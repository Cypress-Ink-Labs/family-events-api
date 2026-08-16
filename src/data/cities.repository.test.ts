import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { CitiesRepository } from "./cities.repository.js"

const LAFAYETTE = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Lafayette",
  slug: "lafayette",
  state: "LA",
  country: "US",
  timezone: "America/Chicago",
  latitude: 30.22,
  longitude: -92.02,
  is_active: true,
}

describe("CitiesRepository", () => {
  it("lists active cities in name order", async () => {
    const query = vi.fn<(text: string, params?: unknown[]) => Promise<(typeof LAFAYETTE)[]>>(
      async () => [LAFAYETTE]
    )
    const repo = new CitiesRepository({ query } as unknown as DbService)
    await expect(repo.listActive()).resolves.toEqual([
      {
        id: LAFAYETTE.id,
        name: "Lafayette",
        slug: "lafayette",
        state: "LA",
        country: "US",
        timezone: "America/Chicago",
        latitude: 30.22,
        longitude: -92.02,
        isActive: true,
      },
    ])
    expect(query.mock.calls[0]?.[0]).toContain("is_active = true")
  })

  it("returns null for an unknown city id", async () => {
    const query = vi.fn(async () => [])
    const repo = new CitiesRepository({ query } as unknown as DbService)
    expect(await repo.findById(LAFAYETTE.id)).toBeNull()
  })
})
