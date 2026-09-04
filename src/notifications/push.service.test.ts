import { Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import { SsrfRejectedError } from "../pipeline/ingestion/guarded-fetch.js"
import type {
  PushRepository,
  PushSubscriptionRow,
  PushVaultCredentials,
} from "./push.repository.js"
import { PushService, type PushServiceDependencies } from "./push.service.js"

function config(values: Partial<Env>): ConfigService<Env, true> {
  return { get: (key: keyof Env) => values[key] } as ConfigService<Env, true>
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
    subscription: (id: string, endpoint = `https://fcm.googleapis.com/wp/${id}`) =>
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

function mobile(
  id: string,
  userId: string,
  platform: "ios" | "android" = "android"
): PushSubscriptionRow {
  return {
    id,
    userId,
    platform,
    endpoint: null,
    token: `token-${id}`,
    p256dh: null,
    authKey: null,
  }
}

const fcmVault: PushVaultCredentials = {
  fcm_service_account_json: JSON.stringify({
    project_id: "family-events",
    client_email: "push@example.iam.gserviceaccount.com",
    private_key: "private",
  }),
}

function providerErrorBody(errorCode: string): string {
  return JSON.stringify({ error: { details: [{ errorCode }], message: "do not log this body" } })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("PushService", () => {
  it("reports unmatched recipients without loading credentials when there are no subscriptions", async () => {
    const { repo, service } = makeService([])

    await expect(
      service.send({
        userIds: ["user-1", "user-1", "user-2"],
        title: "T",
        body: "B",
      })
    ).resolves.toEqual({
      requestedRecipients: 2,
      matchedRecipients: 0,
      unmatchedRecipients: 2,
      sent: 0,
      failed: 0,
      pruned: 0,
      skipped: 0,
    })
    expect(repo.listSubscriptions).toHaveBeenCalledWith(["user-1", "user-2"])
    expect(repo.loadCredentials).not.toHaveBeenCalled()
  })

  it("routes iOS and Android tokens through FCM and soft-skips missing credentials", async () => {
    const { service } = makeService([
      mobile("ios", "user-1", "ios"),
      mobile("android", "user-1", "android"),
    ])

    await expect(service.send({ userIds: ["user-1"], title: "T", body: "B" })).resolves.toEqual({
      requestedRecipients: 1,
      matchedRecipients: 1,
      unmatchedRecipients: 0,
      sent: 0,
      failed: 0,
      pruned: 0,
      skipped: 2,
    })
  })

  it("delivers encrypted web push only to a trusted endpoint through guarded fetch", async () => {
    const web = await makeWebMaterial()
    const guarded = vi.fn(async () => new Response(null, { status: 201 }))
    const { service } = makeService([web.subscription("web-sub")], {}, web.credentials, {
      guardedFetch: guarded,
    })

    await expect(
      service.send({ userIds: ["user-1"], title: "T", body: "B" })
    ).resolves.toMatchObject({
      sent: 1,
      failed: 0,
      pruned: 0,
      skipped: 0,
    })
    expect(guarded).toHaveBeenCalledWith(
      "https://fcm.googleapis.com/wp/web-sub",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
      { resolve: undefined }
    )
  })

  it("rejects an untrusted web endpoint before guarded fetch", async () => {
    const web = await makeWebMaterial()
    const guarded = vi.fn()
    const { service } = makeService(
      [web.subscription("web-sub", "https://push.example.com/device")],
      {},
      web.credentials,
      { guardedFetch: guarded }
    )

    await expect(
      service.send({ userIds: ["user-1"], title: "T", body: "B" })
    ).resolves.toMatchObject({
      failed: 1,
    })
    expect(guarded).not.toHaveBeenCalled()
  })

  it("counts guarded-fetch SSRF rejection as a sanitized failure", async () => {
    const web = await makeWebMaterial()
    const endpoint = "https://updates.push.services.mozilla.com/device"
    const rawFailure = `blocked ${endpoint} token-secret`
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    const guarded = vi.fn(async () => {
      throw new SsrfRejectedError(rawFailure)
    })
    const { service } = makeService(
      [web.subscription("web-secret", endpoint)],
      {},
      web.credentials,
      {
        guardedFetch: guarded,
      }
    )

    await expect(
      service.send({ userIds: ["user-secret"], title: "T", body: "B" })
    ).resolves.toMatchObject({ failed: 1 })
    const logs = warn.mock.calls.flat().join(" ")
    expect(logs).toContain("ssrf_rejected")
    expect(logs).not.toContain("user-secret")
    expect(logs).not.toContain("web-secret")
    expect(logs).not.toContain(endpoint)
    expect(logs).not.toContain("token-secret")
  })

  it("prunes web 404 and 410 responses", async () => {
    const web = await makeWebMaterial()
    const guarded = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
    const { repo, service } = makeService(
      [web.subscription("web-404"), web.subscription("web-410")],
      {},
      web.credentials,
      { guardedFetch: guarded }
    )

    await expect(
      service.send({ userIds: ["user-1"], title: "T", body: "B" })
    ).resolves.toMatchObject({
      failed: 0,
      pruned: 2,
    })
    expect(repo.deleteExpiredSubscriptions).toHaveBeenCalledWith(["web-404", "web-410"])
  })

  it("prunes FCM 400 and 404 only when provider details say UNREGISTERED", async () => {
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(providerErrorBody("UNREGISTERED"), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(providerErrorBody("UNREGISTERED"), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(providerErrorBody("INVALID_ARGUMENT"), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(new Response("not json and private", { status: 404 }))
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    const { repo, service } = makeService(
      [
        mobile("ios-unregistered", "user-1", "ios"),
        mobile("android-unregistered", "user-2"),
        mobile("bad-request", "user-3"),
        mobile("missing", "user-4"),
      ],
      {},
      fcmVault,
      { fetch: providerFetch, getFcmAccessToken: async () => "access-token" }
    )

    await expect(
      service.send({ userIds: ["user-1", "user-2", "user-3", "user-4"], title: "T", body: "B" })
    ).resolves.toMatchObject({ failed: 2, pruned: 2 })
    expect(repo.deleteExpiredSubscriptions).toHaveBeenCalledWith([
      "ios-unregistered",
      "android-unregistered",
    ])
    const logs = warn.mock.calls.flat().join(" ")
    expect(logs).not.toContain("do not log this body")
    expect(logs).not.toContain("not json and private")
    expect(logs).not.toContain("token-")
  })

  it("reports recipient coverage independently from subscription delivery counts", async () => {
    const providerFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    const { service } = makeService([mobile("one", "user-1")], {}, fcmVault, {
      fetch: providerFetch,
      getFcmAccessToken: async () => "access-token",
    })

    await expect(
      service.send({ userIds: ["user-1", "user-2"], title: "T", body: "B" })
    ).resolves.toEqual({
      requestedRecipients: 2,
      matchedRecipients: 1,
      unmatchedRecipients: 1,
      sent: 1,
      failed: 0,
      pruned: 0,
      skipped: 0,
    })
  })
})
