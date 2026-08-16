import { ConfigService } from "@nestjs/config"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FailurePingService } from "./failure-ping.service.js"

function makeService(env: Record<string, string | undefined> = {}): FailurePingService {
  const config = new ConfigService({
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_FAILURE_CHAT_ID: env.TELEGRAM_FAILURE_CHAT_ID,
  })
  return new FailurePingService(config as unknown as ConfigService<never, true>)
}

const configured = {
  TELEGRAM_BOT_TOKEN: "token-1",
  TELEGRAM_FAILURE_CHAT_ID: "chat-1",
}

function mockTelegramOk(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("FailurePingService", () => {
  it("POSTs the legacy HTML payload when both telegram env vars are set", async () => {
    const fetchMock = mockTelegramOk()
    vi.stubGlobal("fetch", fetchMock)

    const outcome = await makeService(configured).send({
      functionName: "process-source-queue",
      kind: "dead_letter",
      subject: "BREC Parks",
      error: "violates check constraint",
    })

    expect(outcome).toBe("sent")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.telegram.org/bottoken-1/sendMessage")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "Content-Type": "application/json" })
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: "chat-1",
      text: [
        "⚠️ <b>process-source-queue</b>: dead-lettered",
        "source: BREC Parks",
        "error: violates check constraint",
      ].join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    })
  })

  it("escapes HTML and truncates the error to 500 characters", async () => {
    const fetchMock = mockTelegramOk()
    vi.stubGlobal("fetch", fetchMock)
    const error = `unexpected <tag> & "quote"${"x".repeat(600)}`

    await makeService(configured).send({
      functionName: "send-weekly-digest",
      kind: "function_failed",
      error,
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    const escaped = error
      .slice(0, 500)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
    expect(body.text).toBe(`⚠️ <b>send-weekly-digest</b>: function crashed\nerror: ${escaped}`)
    expect(error.slice(0, 500).length).toBe(500)
    expect(error.length).toBeGreaterThan(500)
  })

  it("omits the source line when subject is absent", async () => {
    const fetchMock = mockTelegramOk()
    vi.stubGlobal("fetch", fetchMock)

    await makeService(configured).send({
      functionName: "cron-scrape-sources",
      kind: "function_failed",
      error: "boom",
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.text).toBe("⚠️ <b>cron-scrape-sources</b>: function crashed\nerror: boom")
  })

  it("is a no-op when telegram env is missing or incomplete", async () => {
    const fetchMock = mockTelegramOk()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      makeService({}).send({
        functionName: "send-reminders",
        kind: "function_failed",
        error: "boom",
      })
    ).resolves.toBe("skipped")
    await expect(
      makeService({ TELEGRAM_BOT_TOKEN: "token-1" }).send({
        functionName: "send-reminders",
        kind: "function_failed",
        error: "boom",
      })
    ).resolves.toBe("skipped")
    await expect(
      makeService({ TELEGRAM_FAILURE_CHAT_ID: "chat-1" }).send({
        functionName: "send-reminders",
        kind: "function_failed",
        error: "boom",
      })
    ).resolves.toBe("skipped")
    await expect(
      makeService({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_FAILURE_CHAT_ID: "" }).send({
        functionName: "send-reminders",
        kind: "function_failed",
        error: "boom",
      })
    ).resolves.toBe("skipped")

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns failed and does not throw when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )

    await expect(
      makeService(configured).send({
        functionName: "send-reminders",
        kind: "function_failed",
        error: "boom",
      })
    ).resolves.toBe("failed")
  })

  it("returns failed when Telegram reports ok:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, description: "chat not found" }),
      }))
    )

    await expect(
      makeService(configured).send({
        functionName: "send-reminders",
        kind: "function_failed",
        error: "boom",
      })
    ).resolves.toBe("failed")
  })
})
