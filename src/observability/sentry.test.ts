import * as Sentry from "@sentry/nestjs"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { captureUnhandledException, initializeSentry, sentryOptions } from "./sentry.js"

vi.mock("@sentry/nestjs", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}))

const disabled = {
  SENTRY_DSN: undefined,
  SENTRY_ENVIRONMENT: undefined,
  SENTRY_RELEASE: undefined,
  SENTRY_TRACES_SAMPLE_RATE: 0,
}

describe("Sentry integration", () => {
  beforeEach(() => vi.clearAllMocks())

  it("does not initialize or capture when the DSN is absent", () => {
    expect(initializeSentry(disabled)).toBe(false)
    captureUnhandledException(new Error("not sent"))
    expect(Sentry.init).not.toHaveBeenCalled()
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })

  it("initializes with validated labels and sampling", () => {
    const env = {
      SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      SENTRY_ENVIRONMENT: "staging",
      SENTRY_RELEASE: "api@1",
      SENTRY_TRACES_SAMPLE_RATE: 0.2,
    }
    expect(initializeSentry(env)).toBe(true)
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: env.SENTRY_DSN,
        environment: "staging",
        release: "api@1",
        tracesSampleRate: 0.2,
        sendDefaultPii: false,
      })
    )
    const error = new Error("sent")
    captureUnhandledException(error)
    expect(Sentry.captureException).toHaveBeenCalledWith(error)
  })

  it("strips request data, headers, cookies, query strings, DSNs, and HTTP breadcrumbs", async () => {
    const env = {
      ...disabled,
      SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    }
    const options = sentryOptions(env)
    expect(options.beforeBreadcrumb?.({ category: "http", data: { url: "secret" } }, {})).toBeNull()
    const event = await options.beforeSend?.(
      {
        type: undefined,
        request: {
          url: "https://api.example.test/invites?code=plaintext",
          headers: { authorization: "Bearer secret" },
          cookies: { session: "secret" },
          query_string: "code=plaintext",
          data: { code: "plaintext" },
        },
        extra: { dsn: env.SENTRY_DSN },
      },
      {}
    )
    expect(event?.request).toMatchObject({
      url: "https://api.example.test/invites",
      headers: {},
      cookies: {},
      query_string: "[REDACTED]",
      data: "[REDACTED]",
    })
    expect(event?.extra).toEqual({ dsn: "[REDACTED]" })
  })

  it("applies the same policy to transactions and direct pipeline credentials", async () => {
    const env = {
      ...disabled,
      SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    }
    const options = sentryOptions(env, { OPENAI_API_KEY: "direct-pipeline-secret" })
    const event = await options.beforeSendTransaction?.(
      {
        type: "transaction",
        transaction: "GET /v1/admin/invite-codes",
        request: {
          url: "https://api.example.test/path?token=secret",
          headers: { cookie: "session=secret" },
          data: { code: "ABCDEFGHJKLMNPQRSTUV2345" },
        },
        contexts: { pipeline: { model: "prefix direct-pipeline-secret" } },
      },
      {}
    )
    expect(event?.request).toMatchObject({
      url: "https://api.example.test/path",
      headers: {},
      data: "[REDACTED]",
    })
    expect(event?.contexts).toEqual({ pipeline: { model: "[REDACTED]" } })
  })
})
