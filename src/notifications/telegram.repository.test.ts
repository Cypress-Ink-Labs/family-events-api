import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import { TelegramService } from "./telegram.service.js"
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

describe("TelegramRepository bounded Vault waiting", () => {
  it("uses the environment fallback when a Vault query never settles", async () => {
    const query = vi.fn(() => new Promise<never>(() => {}))
    const repository = new TelegramRepository({ query } as unknown as DbService, { timeoutMs: 10 })
    const service = new TelegramService(
      repository,
      new ConfigService({
        TELEGRAM_BOT_TOKEN: "123:environment",
      }) as ConfigService<Env, true>
    )
    await expect(service.resolveBotToken()).resolves.toBe("123:environment")
    expect(query).toHaveBeenCalledOnce()
  })

  it("rejects explicit cancellation promptly instead of using the environment fallback", async () => {
    const controller = new AbortController()
    const reason = new Error("job expired")
    const query = vi.fn(() => new Promise<never>(() => {}))
    const repository = new TelegramRepository({ query } as unknown as DbService)
    const service = new TelegramService(
      repository,
      new ConfigService({
        TELEGRAM_BOT_TOKEN: "123:environment",
      }) as ConfigService<Env, true>
    )
    const pending = service.resolveBotToken(controller.signal)
    const rejected = expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce())
    controller.abort(reason)
    await rejected
  })

  it("observes a late query rejection after a timeout", async () => {
    let rejectQuery!: (error: Error) => void
    const query = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectQuery = reject
        })
    )
    const repository = new TelegramRepository({ query } as unknown as DbService, { timeoutMs: 10 })
    await expect(repository.loadBotToken()).resolves.toBeNull()
    rejectQuery(new Error("late database failure"))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it("rejects before querying when already cancelled", async () => {
    const query = vi.fn()
    const repository = new TelegramRepository({ query } as unknown as DbService)
    await expect(repository.loadBotToken(AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(query).not.toHaveBeenCalled()
  })
})
