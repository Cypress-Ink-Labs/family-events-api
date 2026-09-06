import { ConfigService } from "@nestjs/config"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import type { PlanRepository } from "../data/plan.repository.js"
import type { PlannedEvent } from "../data/types.js"
import type { DigestRepository, DigestUser } from "./digest.repository.js"
import { DigestService, digestSleep } from "./digest.service.js"
import type { MailService, SendMailInput, SendMailResult } from "./mail.service.js"
import type { TelegramRepository } from "./telegram.repository.js"
import {
  type SendTelegramInput,
  type SendTelegramResult,
  TelegramService,
} from "./telegram.service.js"

const now = new Date("2026-09-01T15:00:00Z")
const user = (id: string): DigestUser => ({
  userId: id,
  email: `${id}@example.com`,
  digestEmail: true,
  digestTelegram: true,
  telegramChatId: id,
  displayName: id,
  childAge: 7,
  cityName: "Lafayette",
  lat: 30.22,
  lng: -92.02,
  cityIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
})
const plannedEvent: PlannedEvent = {
  event_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  score: "0.9",
  start_datetime: "2026-09-05T15:00:00.000Z",
  city_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  title: "Storytime",
  venue_name: "Library",
  address: null,
  is_free: true,
  price: null,
  images: [],
  distance_score: "0.9",
  timing_score: "0.8",
}

function makeService() {
  const repository = {
    listDigestUsers: vi.fn(async () => [] as DigestUser[]),
    findDigestUserByEmail: vi.fn(async () => null as DigestUser | null),
  }
  const plans = {
    planForRange: vi.fn(async (_input: Parameters<PlanRepository["planForRange"]>[0]) => [
      plannedEvent,
    ]),
  }
  const mail = {
    send: vi.fn(async (_input: SendMailInput): Promise<SendMailResult> => ({ sent: true })),
  }
  const telegram = {
    resolveBotToken: vi.fn(async (_signal?: AbortSignal): Promise<string | null> => "123:run"),
    send: vi.fn(async (_input: SendTelegramInput): Promise<SendTelegramResult> => ({ sent: true })),
  }
  const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)
  const config = { get: () => "https://events.example.com" } as unknown as ConfigService<Env, true>
  return {
    service: new DigestService(
      repository as unknown as DigestRepository,
      plans as unknown as PlanRepository,
      mail as unknown as MailService,
      config,
      telegram as unknown as TelegramService,
      sleep
    ),
    repository,
    plans,
    mail,
    telegram,
    sleep,
  }
}

describe("digest hardening", () => {
  it.each([0, 1, 5, 6, 10, 11, 1000, 1001, 1005])(
    "paces %i users in five-user batches, including empty plans and page boundaries",
    async (count) => {
      const { service, repository, plans, sleep, telegram } = makeService()
      const users = Array.from({ length: count }, (_, i) => user(String(i).padStart(4, "0")))
      repository.listDigestUsers.mockResolvedValueOnce(users.slice(0, 1000))
      if (count >= 1000) repository.listDigestUsers.mockResolvedValueOnce(users.slice(1000))
      plans.planForRange.mockResolvedValue([])
      const positions: number[] = []
      sleep.mockImplementation(async () => {
        positions.push(plans.planForRange.mock.calls.length)
      })

      await expect(service.processRun(now)).resolves.toEqual({
        emailed: 0,
        skipped: count,
        failed: 0,
        telegramSent: 0,
        telegramSkipped: count,
        telegramFailed: 0,
      })
      expect(positions).toEqual(
        Array.from({ length: Math.max(0, Math.ceil(count / 5) - 1) }, (_, i) => (i + 1) * 5)
      )
      expect(sleep.mock.calls.every(([ms]) => ms === 500)).toBe(true)
      expect(telegram.resolveBotToken).toHaveBeenCalledTimes(count > 0 ? 1 : 0)
      expect(plans.planForRange.mock.calls.map(([input]) => input.userKey)).toEqual(
        users.map(({ userId }) => userId)
      )
    }
  )

  it("does not resolve Telegram credentials for an all-email scheduled run", async () => {
    const { service, repository, mail, telegram } = makeService()
    repository.listDigestUsers.mockResolvedValueOnce([
      { ...user("email"), digestTelegram: false },
      { ...user("another"), digestTelegram: false },
    ])
    await expect(service.processRun(now)).resolves.toMatchObject({ emailed: 2 })
    expect(mail.send).toHaveBeenCalledTimes(2)
    expect(telegram.resolveBotToken).not.toHaveBeenCalled()
  })

  it.each(["123:run", null])(
    "resolves lazily and caches the run token including %s",
    async (token) => {
      const { service, repository, mail, telegram } = makeService()
      repository.listDigestUsers.mockResolvedValueOnce([
        { ...user("email"), digestTelegram: false },
        user("telegram"),
        user("another"),
      ])
      telegram.resolveBotToken.mockImplementation(async () => {
        expect(mail.send).toHaveBeenCalledOnce()
        return token
      })
      await service.processRun(now)
      expect(telegram.resolveBotToken).toHaveBeenCalledOnce()
      expect(telegram.send).toHaveBeenCalledTimes(2)
      for (const [input] of telegram.send.mock.calls) expect(input.token).toBe(token)
    }
  )

  it("resolves one token per scheduled run and keeps serial channel order", async () => {
    const { service, repository, plans, mail, telegram, sleep } = makeService()
    const users = Array.from({ length: 6 }, (_, i) => user(String(i)))
    repository.listDigestUsers.mockResolvedValue(users)
    const trace: string[] = []
    plans.planForRange.mockImplementation(async ({ userKey }) => {
      trace.push(`plan:${userKey}`)
      return [plannedEvent]
    })
    mail.send.mockImplementation(async ({ to }) => {
      trace.push(`email:${to.split("@")[0]}`)
      return { sent: true }
    })
    telegram.send.mockImplementation(async ({ chatId }) => {
      trace.push(`telegram:${chatId}`)
      return { sent: true }
    })
    sleep.mockImplementation(async () => {
      trace.push("sleep")
    })
    await service.processRun(now)
    expect(trace).toEqual(
      users.flatMap((u, i) => [
        ...(i === 5 ? ["sleep"] : []),
        `plan:${u.userId}`,
        `email:${u.userId}`,
        `telegram:${u.userId}`,
      ])
    )
    expect(telegram.resolveBotToken).toHaveBeenCalledOnce()
    for (const [input] of telegram.send.mock.calls) expect(input.token).toBe("123:run")
    telegram.resolveBotToken.mockResolvedValueOnce("456:next")
    await service.processRun(now)
    expect(telegram.resolveBotToken).toHaveBeenCalledTimes(2)
    expect(telegram.send).toHaveBeenLastCalledWith(expect.objectContaining({ token: "456:next" }))
  })

  it("keeps a test email email-only without token resolution or pacing", async () => {
    const { service, repository, mail, telegram, sleep } = makeService()
    repository.findDigestUserByEmail.mockResolvedValue(user("test"))
    await service.processRun(now, "test@example.com")
    expect(mail.send).toHaveBeenCalledOnce()
    expect(telegram.resolveBotToken).not.toHaveBeenCalled()
    expect(telegram.send).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
    expect(repository.listDigestUsers).not.toHaveBeenCalled()
  })

  it.each([undefined, "test@example.com"])(
    "rejects pre-cancelled runs before database work (%s)",
    async (testEmail) => {
      const { service, repository, telegram, plans, sleep } = makeService()
      await expect(service.processRun(now, testEmail, AbortSignal.abort())).rejects.toThrow(
        /abort/i
      )
      expect(repository.listDigestUsers).not.toHaveBeenCalled()
      expect(repository.findDigestUserByEmail).not.toHaveBeenCalled()
      expect(telegram.resolveBotToken).not.toHaveBeenCalled()
      expect(plans.planForRange).not.toHaveBeenCalled()
      expect(sleep).not.toHaveBeenCalled()
    }
  )

  it("stops at the first Telegram recipient if token resolution is cancelled", async () => {
    const { service, repository, telegram } = makeService()
    repository.listDigestUsers.mockResolvedValueOnce([user("telegram")])
    const controller = new AbortController()
    telegram.resolveBotToken.mockImplementation(async () => {
      controller.abort()
      return null
    })
    await expect(service.processRun(now, undefined, controller.signal)).rejects.toThrow(/abort/i)
    expect(telegram.resolveBotToken).toHaveBeenCalledWith(controller.signal)
    expect(repository.listDigestUsers).toHaveBeenCalledOnce()
  })

  it("stops before planning when cancellation arrives during page lookup", async () => {
    const { service, repository, plans } = makeService()
    const controller = new AbortController()
    repository.listDigestUsers.mockImplementation(async () => {
      controller.abort()
      return [user("1")]
    })
    await expect(service.processRun(now, undefined, controller.signal)).rejects.toThrow(/abort/i)
    expect(plans.planForRange).not.toHaveBeenCalled()
  })

  it.each([false, true])("stops after an aborted planner, failure=%s", async (reject) => {
    const { service, repository, plans, mail, telegram } = makeService()
    const controller = new AbortController()
    repository.listDigestUsers.mockResolvedValue([user("1"), user("2")])
    plans.planForRange.mockImplementation(async () => {
      controller.abort()
      if (reject) throw new Error("planner failed")
      return []
    })
    await expect(service.processRun(now, undefined, controller.signal)).rejects.toThrow(/abort/i)
    expect(plans.planForRange).toHaveBeenCalledOnce()
    expect(mail.send).not.toHaveBeenCalled()
    expect(telegram.send).not.toHaveBeenCalled()
  })

  it.each([false, true])("stops after an aborted email, failure=%s", async (reject) => {
    const { service, repository, plans, mail, telegram } = makeService()
    const controller = new AbortController()
    repository.listDigestUsers.mockResolvedValue([user("1"), user("2")])
    mail.send.mockImplementation(async () => {
      controller.abort()
      if (reject) throw new Error("mail failed")
      return { sent: true }
    })
    await expect(service.processRun(now, undefined, controller.signal)).rejects.toThrow(/abort/i)
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
    expect(plans.planForRange).toHaveBeenCalledOnce()
    expect(telegram.send).not.toHaveBeenCalled()
  })

  it("propagates Telegram cancellation before the next user", async () => {
    const { service, repository, plans, telegram } = makeService()
    const controller = new AbortController()
    repository.listDigestUsers.mockResolvedValue([user("1"), user("2")])
    telegram.send.mockImplementation(async () => {
      controller.abort()
      throw controller.signal.reason
    })
    await expect(service.processRun(now, undefined, controller.signal)).rejects.toThrow(/abort/i)
    expect(telegram.send).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    )
    expect(plans.planForRange).toHaveBeenCalledOnce()
  })

  it("stops during pacing before planning the sixth user", async () => {
    const { service, repository, plans, sleep } = makeService()
    const controller = new AbortController()
    repository.listDigestUsers.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => user(String(i)))
    )
    sleep.mockImplementation(async (_ms, signal) => {
      controller.abort()
      signal?.throwIfAborted()
    })
    await expect(service.processRun(now, undefined, controller.signal)).rejects.toThrow(/abort/i)
    expect(sleep).toHaveBeenCalledWith(500, controller.signal)
    expect(plans.planForRange).toHaveBeenCalledTimes(5)
  })

  it("does not request another page after cancellation on the final user", async () => {
    const { service, repository, plans } = makeService()
    const controller = new AbortController()
    repository.listDigestUsers.mockResolvedValue(
      Array.from({ length: 1000 }, (_, i) => user(String(i)))
    )
    plans.planForRange.mockImplementation(async ({ userKey }) => {
      if (userKey === "999") controller.abort()
      return []
    })
    await expect(service.processRun(now, undefined, controller.signal)).rejects.toThrow(/abort/i)
    expect(repository.listDigestUsers).toHaveBeenCalledOnce()
  })

  it("cancels the production delay immediately", async () => {
    const controller = new AbortController()
    const sleeping = digestSleep(500, controller.signal)
    controller.abort()
    await expect(sleeping).rejects.toThrow(/abort/i)
  })
})

function makeTelegram(vaultToken: string | null = "123:vault", envToken?: string) {
  const repository = {
    loadBotToken: vi.fn(async (_signal?: AbortSignal): Promise<string | null> => vaultToken),
  }
  const config = { get: () => envToken } as unknown as ConfigService<Env, true>
  return {
    repository,
    service: new TelegramService(repository as unknown as TelegramRepository, config),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Telegram hardening", () => {
  it("uses explicit run tokens without repeating credential resolution", async () => {
    const { service, repository } = makeTelegram()
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(service.send({ token: "456:run", chatId: "42", text: "Hello" })).resolves.toEqual({
      sent: true,
    })
    expect(repository.loadBotToken).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot456:run/sendMessage",
      expect.any(Object)
    )
  })

  it.each([null, "../../invalid"])(
    "never resolves or fetches an explicit missing or invalid run token (%s)",
    async (token) => {
      const { service, repository } = makeTelegram()
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)
      await expect(service.send({ token, chatId: "42", text: "Hello" })).resolves.toEqual({
        sent: false,
        reason: "missing_configuration",
      })
      expect(repository.loadBotToken).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it("retains validated Vault-first cache and environment fallback", async () => {
    const vault = makeTelegram("123:vault", "456:environment")
    await expect(vault.service.resolveBotToken()).resolves.toBe("123:vault")
    await expect(vault.service.resolveBotToken()).resolves.toBe("123:vault")
    expect(vault.repository.loadBotToken).toHaveBeenCalledOnce()
    const fallback = makeTelegram(null, "456:environment")
    await expect(fallback.service.resolveBotToken()).resolves.toBe("456:environment")
    await expect(fallback.service.resolveBotToken()).resolves.toBe("456:environment")
    expect(fallback.repository.loadBotToken).toHaveBeenCalledOnce()
    const invalid = makeTelegram("../../invalid", "456:environment")
    await expect(invalid.service.resolveBotToken()).resolves.toBeNull()
    await expect(invalid.service.resolveBotToken()).resolves.toBeNull()
    expect(invalid.repository.loadBotToken).toHaveBeenCalledTimes(2)
  })

  it("retries after a transient Vault miss with no valid fallback", async () => {
    const { service, repository } = makeTelegram(null)
    repository.loadBotToken.mockResolvedValueOnce(null).mockResolvedValueOnce("123:recovered")
    await expect(service.resolveBotToken()).resolves.toBeNull()
    await expect(service.resolveBotToken()).resolves.toBe("123:recovered")
    expect(repository.loadBotToken).toHaveBeenCalledTimes(2)
  })

  it("rejects pre-cancellation before credentials or fetch", async () => {
    const { service, repository } = makeTelegram()
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      service.send({ chatId: "42", text: "Hello", signal: AbortSignal.abort() })
    ).rejects.toThrow(/abort/i)
    expect(repository.loadBotToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rethrows cancellation during credential resolution and does not cache the result", async () => {
    const { service, repository } = makeTelegram()
    const controller = new AbortController()
    repository.loadBotToken.mockImplementationOnce(async () => {
      controller.abort()
      return "456:cancelled"
    })
    await expect(service.resolveBotToken(controller.signal)).rejects.toThrow(/abort/i)
    await expect(service.resolveBotToken()).resolves.toBe("123:vault")
    expect(repository.loadBotToken).toHaveBeenCalledTimes(2)
  })

  it("combines provider timeout and job cancellation without soft failure", async () => {
    const { service } = makeTelegram()
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, "timeout")
    let providerSignal: AbortSignal | undefined
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      providerSignal = init.signal as AbortSignal
      controller.abort()
      providerSignal.throwIfAborted()
      return Response.json({ ok: true })
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      service.send({ token: "123:run", chatId: "42", text: "Hello", signal: controller.signal })
    ).rejects.toThrow(/abort/i)
    expect(timeout).toHaveBeenCalledWith(10_000)
    expect(providerSignal).not.toBe(controller.signal)
    expect(providerSignal?.aborted).toBe(true)
  })

  it("rethrows cancellation while reading the provider response", async () => {
    const { service } = makeTelegram()
    const controller = new AbortController()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          controller.abort()
          return { ok: true }
        },
      }))
    )
    await expect(
      service.send({ token: "123:run", chatId: "42", text: "Hello", signal: controller.signal })
    ).rejects.toThrow(/abort/i)
  })
})
