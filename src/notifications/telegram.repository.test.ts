import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { TelegramRepository } from "./telegram.repository.js"

describe("TelegramRepository", () => {
  it("loads only the named vault secret through a parameterized query", async () => {
    const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [
      { botToken: " vault-token " },
    ])
    const repository = new TelegramRepository({ query } as unknown as DbService)

    await expect(repository.loadBotToken()).resolves.toBe("vault-token")
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("FROM vault.decrypted_secrets")
    expect(sql).toContain("WHERE name = $1")
    expect(sql).not.toContain("telegram_bot_token")
    expect(params).toEqual(["telegram_bot_token"])
  })

  it("soft-fails when Vault is unavailable", async () => {
    const query = vi.fn(async () => {
      throw new Error("vault unavailable")
    })
    const repository = new TelegramRepository({ query } as unknown as DbService)
    await expect(repository.loadBotToken()).resolves.toBeNull()
  })
})
