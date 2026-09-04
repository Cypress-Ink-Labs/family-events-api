import { Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import type {
  PushRepository,
  PushSubscriptionRow,
  PushVaultCredentials,
} from "./push.repository.js"
import { PushService, type PushServiceDependencies } from "./push.service.js"

function config(values: Partial<Env>): ConfigService<Env, true> {
  return {
    get: (key: keyof Env) => values[key],
  } as ConfigService<Env, true>
}

function repository(rows: PushSubscriptionRow[], vault: PushVaultCredentials = {}) {
  return {
    listSubscriptions: vi.fn(async () => rows),
    loadCredentials: vi.fn(async () => vault),
    deleteExpiredSubscriptions: vi.fn(async () => undefined),
  }
}

function makeService(
  rows: PushSubscriptionRow[],
  values: Partial<Env> = {},
  vault: PushVaultCredentials = {},
  dependencies: PushServiceDependencies = {}
) {
  const repo = repository(rows, vault)
  return {
    repo,
    service: new PushService(repo as unknown as PushRepository, config(values), dependencies),
  }
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    "base64url"
  )
}

async function makeWebMaterial() {
  const vapidKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
  const vapidPrivateJwk = await crypto.subtle.exportKey("jwk", vapidKeys.privateKey)
  const vapidPublic = await crypto.subtle.exportKey("raw", vapidKeys.publicKey)
  const subscriberKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  )
  const subscriberPublic = await crypto.subtle.exportKey("raw", subscriberKeys.publicKey)

  return {
    credentials: {
      vapid_private_key: vapidPrivateJwk.d!,
      vapid_public_key: base64url(vapidPublic),
      vapid_subject: "mailto:push@example.com",
    } satisfies PushVaultCredentials,
    subscription: (id: string, endpoint = `https://push.example.com/${id}`) =>
      ({
        id,
        userId: "11111111-1111-4111-8111-111111111111",
        platform: "web",
        endpoint,
        token: null,
        p256dh: base64url(subscriberPublic),
        authKey: base64url(crypto.getRandomValues(new Uint8Array(16))),
      }) satisfies PushSubscriptionRow,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("PushService", () => {
  it("returns zero counts without loading credentials when there are no subscriptions", async () => {
    const { repo, service } = makeService([])

    await expect(
      service.send({ userIds: ["11111111-1111-4111-8111-111111111111"], title: "T", body: "B" })
    ).resolves.toEqual({ sent: 0, failed: 0, pruned: 0, skipped: 0 })
    expect(repo.listSubscriptions).toHaveBeenCalledTimes(1)
    expect(repo.loadCredentials).not.toHaveBeenCalled()
  })

  it("soft-skips each provider when its credentials are absent", async () => {
    const rows: PushSubscriptionRow[] = [
      {
        id: "web-sub",
        userId: "user-1",
        platform: "web",
        endpoint: "https://push.example.com/1",
        token: null,
        p256dh: "key",
        authKey: "auth",
      },
      {
        id: "ios-sub",
        userId: "user-1",
        platform: "ios",
        endpoint: null,
        token: "ios-token",
        p256dh: null,
        authKey: null,
      },
      {
        id: "android-sub",
        userId: "user-1",
        platform: "android",
        endpoint: null,
        token: "android-token",
        p256dh: null,
        authKey: null,
      },
    ]
    const { service } = makeService(rows)

    await expect(service.send({ userIds: ["user-1"], title: "T", body: "B" })).resolves.toEqual({
      sent: 0,
      failed: 0,
      pruned: 0,
      skipped: 3,
    })
  })

  it("delivers a valid encrypted web push through guarded fetch using vault credentials", async () => {
    const web = await makeWebMaterial()
    const fetchMock = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => new Response(null, { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)
    const { service } = makeService([web.subscription("web-sub")], {}, web.credentials, {
      resolve: async () => ({ ok: true }),
    })

    await expect(service.send({ userIds: ["user-1"], title: "T", body: "B" })).resolves.toEqual({
      sent: 1,
      failed: 0,
      pruned: 0,
      skipped: 0,
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://push.example.com/web-sub")
    expect(init).toMatchObject({ method: "POST", redirect: "manual" })
    expect(new Headers(init!.headers).get("content-encoding")).toBe("aes128gcm")
    expect(init!.signal).toBeInstanceOf(AbortSignal)
  })

  it("falls back to environment VAPID keys and applies the legacy subject default", async () => {
    const web = await makeWebMaterial()
    const fetchMock = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => new Response(null, { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)
    const { service } = makeService(
      [web.subscription("web-env")],
      {
        VAPID_PRIVATE_KEY: web.credentials.vapid_private_key,
        VAPID_PUBLIC_KEY: web.credentials.vapid_public_key,
      },
      {},
      { resolve: async () => ({ ok: true }) }
    )

    await expect(service.send({ userIds: ["user-1"], title: "T", body: "B" })).resolves.toEqual({
      sent: 1,
      failed: 0,
      pruned: 0,
      skipped: 0,
    })
    const authorization = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")
    const encodedPayload = authorization?.split(".")[1]
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString()) as {
      sub: string
    }
    expect(payload.sub).toBe("mailto:push@cypress-ink-labs.org")
  })

  it("counts a guarded-fetch SSRF rejection as a sanitized delivery failure", async () => {
    const web = await makeWebMaterial()
    const endpoint = "http://127.0.0.1/private-device"
    const rawFailure = `blocked ${endpoint} for web-sub with secret-value`
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { service } = makeService([web.subscription("web-sub", endpoint)], {}, web.credentials, {
      resolve: async () => ({ ok: false, reason: rawFailure }),
    })

    await expect(
      service.send({ userIds: ["user-secret"], title: "T", body: "B" })
    ).resolves.toEqual({ sent: 0, failed: 1, pruned: 0, skipped: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
    const logs = warn.mock.calls.flat().join(" ")
    expect(logs).toContain("ssrf_rejected")
    expect(logs).not.toContain("user-secret")
    expect(logs).not.toContain("web-sub")
    expect(logs).not.toContain(endpoint)
    expect(logs).not.toContain("secret-value")
  })

  it("prunes the exact legacy web, APNs, and FCM statuses", async () => {
    const web = await makeWebMaterial()
    const rows: PushSubscriptionRow[] = [
      web.subscription("web-404"),
      web.subscription("web-410"),
      ...[400, 410].map(
        (status) =>
          ({
            id: `ios-${status}`,
            userId: "user-1",
            platform: "ios",
            endpoint: null,
            token: `ios-token-${status}`,
            p256dh: null,
            authKey: null,
          }) satisfies PushSubscriptionRow
      ),
      ...[400, 404].map(
        (status) =>
          ({
            id: `fcm-${status}`,
            userId: "user-1",
            platform: "android",
            endpoint: null,
            token: `fcm-token-${status}`,
            p256dh: null,
            authKey: null,
          }) satisfies PushSubscriptionRow
      ),
    ]
    const webFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
    vi.stubGlobal("fetch", webFetch)
    const providerFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const token = init?.body
        ? (JSON.parse(String(init.body)) as { message?: { token?: string } }).message?.token
        : undefined
      const status = Number(url.match(/(400|404|410)$/)?.[1] ?? token?.match(/(400|404)$/)?.[1])
      return new Response(null, { status })
    })
    const vault: PushVaultCredentials = {
      ...web.credentials,
      apns_team_id: "team",
      apns_key_id: "key",
      apns_private_key: "private",
      apns_bundle_id: "com.example.family",
      apns_environment: "production",
      fcm_service_account_json: JSON.stringify({
        project_id: "family-events",
        client_email: "push@example.iam.gserviceaccount.com",
        private_key: "private",
      }),
    }
    const dependencies: PushServiceDependencies = {
      fetch: providerFetch as typeof fetch,
      resolve: async () => ({ ok: true }),
      signApnsJwt: async () => "apns-jwt",
      getFcmAccessToken: async () => "fcm-access-token",
    }
    const { repo, service } = makeService(rows, {}, vault, dependencies)

    await expect(service.send({ userIds: ["user-1"], title: "T", body: "B" })).resolves.toEqual({
      sent: 0,
      failed: 0,
      pruned: 6,
      skipped: 0,
    })
    expect(repo.deleteExpiredSubscriptions).toHaveBeenCalledWith([
      "web-404",
      "web-410",
      "ios-400",
      "ios-410",
      "fcm-400",
      "fcm-404",
    ])
  })
})
