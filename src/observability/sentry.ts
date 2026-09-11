import * as Sentry from "@sentry/nestjs"
import type { Breadcrumb } from "@sentry/nestjs"

import type { Env } from "../config/env.js"
import { redact, REDACTED_VALUE } from "./redaction.js"

let enabled = false

type SentryEnv = Pick<
  Env,
  "SENTRY_DSN" | "SENTRY_ENVIRONMENT" | "SENTRY_TRACES_SAMPLE_RATE" | "SENTRY_RELEASE"
> &
  Partial<Env>

const DIRECT_SECRET_NAMES = [
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "UNSPLASH_ACCESS_KEY",
  "PEXELS_API_KEY",
  "PIXABAY_API_KEY",
] as const

function knownSecrets(env: SentryEnv, runtimeEnv: Record<string, string | undefined>): string[] {
  return [
    env.SENTRY_DSN,
    env.DATABASE_URL,
    env.CLERK_SECRET_KEY,
    env.TELEGRAM_BOT_TOKEN,
    env.OPENWEATHER_API_KEY,
    env.RESEND_API_KEY,
    env.VAPID_PRIVATE_KEY,
    env.FCM_SERVICE_ACCOUNT_JSON,
    ...DIRECT_SECRET_NAMES.map((name) => runtimeEnv[name]),
  ].filter((value): value is string => Boolean(value))
}

function sanitizeEvent<T extends { request?: Sentry.Event["request"] }>(
  event: T,
  sensitiveValues: string[]
): T {
  const safe = redact(event, { sensitiveValues }) as T
  if (safe.request) {
    safe.request.data = REDACTED_VALUE
    safe.request.query_string = REDACTED_VALUE
    safe.request.cookies = {}
    safe.request.headers = {}
    if (safe.request.url) safe.request.url = safe.request.url.split("?")[0]
  }
  return safe
}

export function sentryOptions(
  env: SentryEnv,
  runtimeEnv: Record<string, string | undefined> = process.env
): NonNullable<Parameters<typeof Sentry.init>[0]> {
  const sensitiveValues = knownSecrets(env, runtimeEnv)
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
      if (breadcrumb.category === "http") return null
      return redact(breadcrumb, { sensitiveValues }) as Breadcrumb
    },
    beforeSend(event) {
      return sanitizeEvent(event, sensitiveValues)
    },
    beforeSendTransaction(event) {
      return sanitizeEvent(event, sensitiveValues)
    },
  }
}

export function initializeSentry(
  env: SentryEnv,
  runtimeEnv: Record<string, string | undefined> = process.env
): boolean {
  if (!env.SENTRY_DSN) {
    enabled = false
    return false
  }
  Sentry.init(sentryOptions(env, runtimeEnv))
  enabled = true
  return true
}

export function captureUnhandledException(exception: unknown): void {
  if (enabled) Sentry.captureException(exception)
}
