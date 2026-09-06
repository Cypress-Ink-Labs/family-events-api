import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { DigestRepository } from "./digest.repository.js"

const primaryRow = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "reader@example.com",
  digestEmail: true,
  digestTelegram: false,
  telegramChatId: null,
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
        digestEmail: true,
        digestTelegram: false,
        telegramChatId: null,
        displayName: "Reader",
        childAge: 7,
        cityName: "Lafayette",
        lat: 30.22,
        lng: -92.02,
        cityIds: [primaryRow.primaryCityId],
      },
    ])
  })

  it("selects either digest channel and permits Telegram-only users without email", async () => {
    const query = vi
      .fn<(text: string, params?: unknown[]) => Promise<unknown[]>>()
      .mockResolvedValueOnce([
        {
          ...primaryRow,
          email: null,
          digestEmail: false,
          digestTelegram: true,
          telegramChatId: "-100123",
        },
      ])
      .mockResolvedValueOnce([])
    const repository = new DigestRepository({ query } as unknown as DbService)

    await expect(repository.listDigestUsers(null, 1000)).resolves.toEqual([
      expect.objectContaining({
        email: null,
        digestEmail: false,
        digestTelegram: true,
        telegramChatId: "-100123",
      }),
    ])
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("WHERE (unp.digest_email IS TRUE OR unp.digest_telegram IS TRUE)")
    expect(sql).not.toContain("JOIN public.user_profiles p ON p.id = unp.user_id\n  AND nullif")
    expect(params).toEqual([null, 1000])
  })
})
