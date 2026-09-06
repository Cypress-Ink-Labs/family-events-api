import { Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import type { TelegramRepository } from "./telegram.repository.js"
import { TelegramService } from "./telegram.service.js"

function makeService(vaultToken: string | null, envToken?: string) {
  const repository = { loadBotToken: vi.fn(async () => vaultToken) }
  const config = {
    get: (key: keyof Env) => (key === "TELEGRAM_BOT_TOKEN" ? envToken : undefined),
  } as ConfigService<Env, true>
  return {
    repository,
    service: new TelegramService(repository as unknown as TelegramRepository, config),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("TelegramService", () => {
  it("prefers Vault and posts HTML to Telegram without redirects", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    const { service } = makeService("123:vault", "456:environment")

    await expect(service.send({ chatId: "-10042", text: "<b>Hi</b>" })).resolves.toEqual({
      sent: true,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:vault/sendMessage",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({
          chat_id: "-10042",
          text: "<b>Hi</b>",
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      })
    )
  })

  it("uses the environment fallback and caches credential resolution", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true }))
    )
    const { repository, service } = makeService(null, "123:environment")
    await service.send({ chatId: "1", text: "One" })
    await service.send({ chatId: "2", text: "Two" })
    expect(repository.loadBotToken).toHaveBeenCalledTimes(1)
  })

  it("retries credential lookup after a transient Vault miss", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    const repository = {
      loadBotToken: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("123:recovered"),
    }
    const config = { get: () => undefined } as unknown as ConfigService<Env, true>
    const service = new TelegramService(repository as unknown as TelegramRepository, config)

    await expect(service.send({ chatId: "42", text: "First" })).resolves.toEqual({
      sent: false,
      reason: "missing_configuration",
    })
    await expect(service.send({ chatId: "42", text: "Second" })).resolves.toEqual({ sent: true })
    expect(repository.loadBotToken).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("soft-skips missing or invalid configuration without fetching", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(makeService(null).service.send({ chatId: "42", text: "Hi" })).resolves.toEqual({
      sent: false,
      reason: "missing_configuration",
    })
    await expect(
      makeService("../../invalid").service.send({ chatId: "42", text: "Hi" })
    ).resolves.toEqual({ sent: false, reason: "missing_configuration" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("soft-fails rejected and malformed responses without logging secrets", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 502 }))
    )
    const { service } = makeService("123:secret")
    await expect(service.send({ chatId: "42", text: "Hi" })).resolves.toEqual({
      sent: false,
      reason: "failed",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("123:secret")
  })
})
