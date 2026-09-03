import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { DigestRepository } from "./digest.repository.js"

const primaryRow = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "reader@example.com",
  displayName: "Reader",
  childAge: 7,
  primaryCityId: "22222222-2222-4222-8222-222222222222",
  cityName: "Lafayette",
  lat: 30.22,
  lng: -92.02,
}

describe("DigestRepository", () => {
  it("falls back to the primary city when the optional preferred-city lookup fails", async () => {
    const query = vi
      .fn<(text: string, params?: unknown[]) => Promise<unknown[]>>()
      .mockResolvedValueOnce([primaryRow])
      .mockRejectedValueOnce(new Error("relation unavailable"))
    const repository = new DigestRepository({ query } as unknown as DbService)

    await expect(repository.listDigestUsers(null, 1000)).resolves.toEqual([
      {
        userId: primaryRow.userId,
        email: "reader@example.com",
        displayName: "Reader",
        childAge: 7,
        cityName: "Lafayette",
        lat: 30.22,
        lng: -92.02,
        cityIds: [primaryRow.primaryCityId],
      },
    ])
  })
})
