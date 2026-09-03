import { ConfigService } from "@nestjs/config"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import { MailService } from "./mail.service.js"

const FROM = "Family Events <hello@example.com>"

function makeMailService(values: Partial<Env>): MailService {
  const config = {
    get: (key: keyof Env) => values[key],
  } as ConfigService<Env, true>
  return new MailService(config)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("MailService", () => {
  it("posts a hosted-template payload to Resend with a 10s timeout", async () => {
    const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 })
    )
    vi.stubGlobal("fetch", fetchMock)
    const mail = makeMailService({ RESEND_API_KEY: "re_test", RESEND_FROM: FROM })

    const result = await mail.send({
      to: "user@example.com",
      subject: "Reminder",
      templateId: "family-events-event-reminder",
      variables: { USERNAME: "Reader" },
    })

    expect(result).toEqual({ sent: true, status: 200 })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.resend.com/emails")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(String(init.body))).toEqual({
      from: FROM,
      to: "user@example.com",
      subject: "Reminder",
      template: {
        id: "family-events-event-reminder",
        variables: { USERNAME: "Reader" },
      },
    })
  })

  it("soft-fails without an API key", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const mail = makeMailService({ RESEND_FROM: FROM })

    await expect(
      mail.send({ to: "user@example.com", subject: "s", html: "<p>x</p>" })
    ).resolves.toEqual({ sent: false, dev: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns sent:false on a Resend error status and never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 422 }))
    )
    const mail = makeMailService({ RESEND_API_KEY: "re_test", RESEND_FROM: FROM })

    await expect(
      mail.send({ to: "user@example.com", subject: "s", html: "<p>x</p>" })
    ).resolves.toEqual({ sent: false, status: 422 })
  })

  it("maps network and timeout failures to sent:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout")
      })
    )
    const mail = makeMailService({ RESEND_API_KEY: "re_test", RESEND_FROM: FROM })

    await expect(
      mail.send({ to: "user@example.com", subject: "s", html: "<p>x</p>" })
    ).resolves.toEqual({ sent: false })
  })

  it("rejects ambiguous or empty content as a programmer error", async () => {
    const mail = makeMailService({ RESEND_API_KEY: "re_test", RESEND_FROM: FROM })
    await expect(
      mail.send({
        to: "user@example.com",
        subject: "s",
        html: "<p>x</p>",
        templateId: "template",
      })
    ).rejects.toThrow(/exactly one/)
    await expect(mail.send({ to: "user@example.com", subject: "s" })).rejects.toThrow(/exactly one/)
  })
})
