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
      failedBatches: 0,
      failedBatchRecipients: 0,
      sent: 0,
      failed: 0,
      pruned: 0,
      skipped: 0,
    })
    expect(repo.listSubscriptions).toHaveBeenCalledWith(["user-1", "user-2"])
    expect(repo.loadCredentials).not.toHaveBeenCalled()
  })

  it("reuses subscriptions and credentials within an explicit send context", async () => {
    const subscription = mobile("sub-1", "11111111-1111-4111-8111-111111111111")
    const { repo, service } = makeService([subscription])
    const context = service.createSendContext()
    const input = {
      userIds: [subscription.userId],
      title: "Reminder",
      body: "Body",
    }

    await service.send(input, context)
    await service.send({ ...input, title: "Another reminder" }, context)

    expect(repo.listSubscriptions).toHaveBeenCalledTimes(1)
    expect(repo.loadCredentials).toHaveBeenCalledTimes(1)
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
      failedBatches: 0,
      failedBatchRecipients: 0,
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
      { resolve: expect.any(Function) }
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

  it("passes the same combined timeout and job signal through real guarded fetch and DNS", async () => {
    const web = await makeWebMaterial()
    const controller = new AbortController()
    const resolve = vi.fn(async (_url: string, _signal?: AbortSignal) => ({ ok: true }))
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 201 })
    )
    vi.stubGlobal("fetch", fetchMock)
    const timeout = vi.spyOn(AbortSignal, "timeout")
    const { service } = makeService([web.subscription("signal")], {}, web.credentials, { resolve })

    await expect(
      service.send({ userIds: ["user-1"], title: "T", body: "B" }, undefined, controller.signal)
    ).resolves.toMatchObject({ sent: 1 })
    expect(timeout).toHaveBeenCalledWith(10_000)
    const requestSignal = fetchMock.mock.calls[0]![1]!.signal
    expect(requestSignal).toBeInstanceOf(AbortSignal)
    expect(requestSignal).not.toBe(controller.signal)
    expect(resolve).toHaveBeenCalledWith(web.subscription("signal").endpoint, requestSignal)
    controller.abort()
    expect(requestSignal!.aborted).toBe(true)
  })

  it("aborts a stalled DNS lookup through real guarded fetch without sending", async () => {
    const web = await makeWebMaterial()
    const controller = new AbortController()
    const reason = new Error("job cancelled during DNS")
    const resolve = vi.fn(
      (_url: string, _signal?: AbortSignal) => new Promise<{ ok: boolean }>(() => {})
    )
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { service } = makeService([web.subscription("stalled")], {}, web.credentials, { resolve })
    const pending = service.send(
      { userIds: ["user-1"], title: "T", body: "B" },
      undefined,
      controller.signal
    )
    const rejected = expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    controller.abort(reason)
    await rejected
    expect(resolve.mock.calls[0]![1]!.aborted).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects an HTTPS provider redirect that downgrades to HTTP", async () => {
    const web = await makeWebMaterial()
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://fcm.googleapis.com/private" },
        })
    )
    vi.stubGlobal("fetch", fetchMock)
    const { service } = makeService([web.subscription("redirect")], {}, web.credentials, {
      resolve: async () => ({ ok: true }),
    })

    await expect(
      service.send({ userIds: ["user-1"], title: "T", body: "B" })
    ).resolves.toMatchObject({ sent: 0, failed: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
      "android-unregistered",
      "ios-unregistered",
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
      failedBatches: 0,
      failedBatchRecipients: 0,
      sent: 1,
      failed: 0,
      pruned: 0,
      skipped: 0,
    })
  })

  it("delivers with bounded concurrency when some provider requests stall", async () => {
    let active = 0
    let maximumActive = 0
    const providerFetch = vi.fn<typeof fetch>(async () => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return new Response(null, { status: 200 })
    })
    const rows = Array.from({ length: 25 }, (_, index) => mobile(`sub-${index}`, `user-${index}`))
    const { service } = makeService(rows, {}, fcmVault, {
      fetch: providerFetch,
      getFcmAccessToken: async () => "access-token",
    })

    await expect(
      service.send({
        userIds: rows.map((row) => row.userId),
        title: "T",
        body: "B",
      })
    ).resolves.toMatchObject({ sent: 25, failed: 0 })
    expect(maximumActive).toBeGreaterThan(1)
    expect(maximumActive).toBeLessThanOrEqual(10)
  })

  it.each([false, true])(
    "chunks 1001 recipients and continues when the first lookup fails: %s",
    async (firstFails) => {
      const userIds = Array.from({ length: 1001 }, (_, index) => `user-${index}`)
      const providerFetch = vi.fn(async () => new Response(null, { status: 200 }))
      const { service, repo } = makeService([], {}, fcmVault, {
        fetch: providerFetch,
        getFcmAccessToken: async () => "access-token",
      })
      if (firstFails) repo.listSubscriptions.mockRejectedValueOnce(new Error("database failed"))
      else repo.listSubscriptions.mockResolvedValueOnce([mobile("first", userIds[0]!)])
      repo.listSubscriptions.mockResolvedValueOnce([mobile("last", userIds[1000]!)])

      const result = await service.send({
        userIds: [...userIds, userIds[0]!],
        title: "T",
        body: "B",
      })

      expect(repo.listSubscriptions).toHaveBeenNthCalledWith(1, userIds.slice(0, 1000))
      expect(repo.listSubscriptions).toHaveBeenNthCalledWith(2, [userIds[1000]])
      expect(repo.listSubscriptions).toHaveBeenCalledTimes(2)
      expect(providerFetch).toHaveBeenCalledTimes(firstFails ? 1 : 2)
      expect(result).toEqual({
        requestedRecipients: 1001,
        matchedRecipients: firstFails ? 1 : 2,
        unmatchedRecipients: firstFails ? 0 : 999,
        failedBatches: firstFails ? 1 : 0,
        failedBatchRecipients: firstFails ? 1000 : 0,
        sent: firstFails ? 1 : 2,
        failed: 0,
        skipped: 0,
        pruned: 0,
      })
    }
  )

  it("cancels before any lookup and after a pending lookup without sending", async () => {
    const controller = new AbortController()
    const { service, repo } = makeService([mobile("first", "user-1")])
    const reason = new Error("shutdown")
    repo.listSubscriptions.mockImplementationOnce(async () => {
      controller.abort(reason)
      return [mobile("first", "user-1")]
    })
    await expect(
      service.send({ userIds: ["user-1"], title: "T", body: "B" }, undefined, controller.signal)
    ).rejects.toBe(reason)
    expect(repo.loadCredentials).not.toHaveBeenCalled()
    await expect(
      service.send({ userIds: ["user-1"], title: "T", body: "B" }, undefined, controller.signal)
    ).rejects.toBe(reason)
    expect(repo.listSubscriptions).toHaveBeenCalledTimes(1)
  })

  it("propagates OAuth cancellation without sending providers or later chunks", async () => {
    const controller = new AbortController()
    const reason = new Error("shutdown")
    const providerFetch = vi.fn()
    const getToken = vi.fn(async (_credentials, options) => {
      expect(options?.signal).toBe(controller.signal)
      controller.abort(reason)
      throw reason
    })
    const { service, repo } = makeService([mobile("first", "user-0")], {}, fcmVault, {
      fetch: providerFetch,
      getFcmAccessToken: getToken,
    })
    await expect(
      service.send(
        {
          userIds: Array.from({ length: 1001 }, (_, index) => `user-${index}`),
          title: "T",
          body: "B",
        },
        undefined,
        controller.signal
      )
    ).rejects.toBe(reason)
    expect(providerFetch).not.toHaveBeenCalled()
    expect(repo.listSubscriptions).toHaveBeenCalledTimes(1)
  })

  it.each(["web", "fcm"])(
    "propagates %s provider cancellation through its combined timeout signal",
    async (provider) => {
      const controller = new AbortController()
      const reason = new Error("shutdown")
      const web = await makeWebMaterial()
      const providerFetch = vi.fn(async (_url, init) => {
        expect(init.signal).not.toBe(controller.signal)
        expect(init.signal.aborted).toBe(false)
        controller.abort(reason)
        expect(init.signal.aborted).toBe(true)
        throw reason
      })
      const { service, repo } =
        provider === "web"
          ? makeService([web.subscription("web-sub")], {}, web.credentials, {
              guardedFetch: providerFetch,
            })
          : makeService([mobile("first", "user-1")], {}, fcmVault, {
              fetch: providerFetch,
              getFcmAccessToken: async () => "token",
            })
      await expect(
        service.send({ userIds: ["user-1"], title: "T", body: "B" }, undefined, controller.signal)
      ).rejects.toBe(reason)
      expect(repo.deleteExpiredSubscriptions).not.toHaveBeenCalled()
    }
  )

  it("keeps encrypted Web Push below provider limits for long Unicode text", async () => {
    const web = await makeWebMaterial()
    const guarded = vi.fn(async (_url, init) => {
      expect((init.body as ArrayBuffer).byteLength).toBeLessThan(4096)
      return new Response(null, { status: 201 })
    })
    const { service } = makeService([web.subscription("web-sub")], {}, web.credentials, {
      guardedFetch: guarded,
    })
    await expect(
      service.send({
        userIds: ["user-1"],
        title: '🌍"\\'.repeat(3000),
        body: "家族🎉".repeat(3000),
        url: "https://events.example.com/events/1",
      })
    ).resolves.toMatchObject({ sent: 1, failed: 0 })
    expect(guarded).toHaveBeenCalledTimes(1)
  })

  it.each(["web", "fcm"])(
    "soft-fails impossible URL overhead before %s delivery",
    async (provider) => {
      const web = await makeWebMaterial()
      const providerFetch = vi.fn()
      const { service } =
        provider === "web"
          ? makeService([web.subscription("web-sub")], {}, web.credentials, {
              guardedFetch: providerFetch,
            })
          : makeService([mobile("first", "user-1")], {}, fcmVault, {
              fetch: providerFetch,
              getFcmAccessToken: async () => "token",
            })
      await expect(
        service.send({
          userIds: ["user-1"],
          title: "T",
          body: "B",
          url: `https://events.example.com/${"🌍".repeat(3000)}`,
        })
      ).resolves.toMatchObject({ sent: 0, failed: 1 })
      expect(providerFetch).not.toHaveBeenCalled()
    }
  )
})

describe("PushService bounded database waits", () => {
  const input = { userIds: ["user-1"], title: "T", body: "B" }

  function dbHarness(dbTimeoutMs = 10_000) {
    const provider = vi.fn(async () => new Response(null, { status: 200 }))
    const { service, repo } = makeService(
      [mobile("sub-1", "user-1")],
      { FCM_SERVICE_ACCOUNT_JSON: fcmVault.fcm_service_account_json },
      fcmVault,
      { dbTimeoutMs, fetch: provider, getFcmAccessToken: async () => "token" }
    )
    return { service, repo, provider }
  }

  it.each(["listSubscriptions", "loadCredentials", "deleteExpiredSubscriptions"] as const)(
    "promptly cancels a never-settling %s without reporting a failure or fallback",
    async (method) => {
      const { service, repo, provider } = dbHarness()
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {})
      const controller = new AbortController()
      const reason = new Error("job cancelled")
      repo[method].mockImplementation(() => new Promise<never>(() => {}))
      if (method === "deleteExpiredSubscriptions") {
        provider.mockImplementation(
          async () => new Response(providerErrorBody("UNREGISTERED"), { status: 404 })
        )
      }
      const pending = service.send(input, service.createSendContext(), controller.signal)
      const rejected = expect(pending).rejects.toBe(reason)
      await vi.waitFor(() => expect(repo[method]).toHaveBeenCalledOnce())
      controller.abort(reason)
      await rejected
      expect(warn).not.toHaveBeenCalled()
      if (method !== "deleteExpiredSubscriptions") expect(provider).not.toHaveBeenCalled()
    }
  )

  it("reports a timed-out subscription chunk separately and continues later chunks", async () => {
    const { service, repo, provider } = dbHarness(10)
    const userIds = Array.from({ length: 1001 }, (_, i) => `user-${i}`)
    repo.listSubscriptions
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockResolvedValueOnce([mobile("last", "user-1000")])
    await expect(service.send({ ...input, userIds })).resolves.toMatchObject({
      requestedRecipients: 1001,
      matchedRecipients: 1,
      unmatchedRecipients: 0,
      failedBatches: 1,
      failedBatchRecipients: 1000,
      sent: 1,
      failed: 0,
    })
    expect(repo.listSubscriptions).toHaveBeenCalledTimes(2)
    expect(provider).toHaveBeenCalledOnce()
  })

  it.each(["timeout", "database error"])(
    "uses cached environment credentials after Vault %s",
    async (failure) => {
      const { service, repo, provider } = dbHarness(10)
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {})
      if (failure === "timeout")
        repo.loadCredentials.mockImplementation(() => new Promise<never>(() => {}))
      else repo.loadCredentials.mockRejectedValue(new Error("private database credentials"))
      const context = service.createSendContext()
      await expect(service.send(input, context)).resolves.toMatchObject({
        sent: 1,
        failed: 0,
        failedBatches: 0,
      })
      await expect(service.send(input, context)).resolves.toMatchObject({ sent: 1, failed: 0 })
      expect(repo.loadCredentials).toHaveBeenCalledOnce()
      expect(repo.listSubscriptions).toHaveBeenCalledOnce()
      expect(provider).toHaveBeenCalledTimes(2)
      expect(warn.mock.calls).toEqual([["push credential lookup failed: vault_unavailable"]])
    }
  )

  it("retains failed/pruned accounting when expired-subscription deletion times out", async () => {
    const { service, repo, provider } = dbHarness(10)
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {})
    provider.mockImplementation(
      async () => new Response(providerErrorBody("UNREGISTERED"), { status: 404 })
    )
    repo.deleteExpiredSubscriptions.mockImplementation(() => new Promise<never>(() => {}))
    await expect(service.send(input)).resolves.toMatchObject({
      sent: 0,
      failed: 1,
      pruned: 0,
      failedBatches: 0,
      failedBatchRecipients: 0,
    })
    expect(warn.mock.calls).toEqual([["push prune failed: category=database count=1"]])
  })

  it.each(["listSubscriptions", "loadCredentials"] as const)(
    "cancels waiting on cached %s without duplicating or cancelling another waiter's query",
    async (method) => {
      const { service, repo, provider } = dbHarness()
      let complete!: () => void
      const query = new Promise<never>((resolve) => {
        complete = () =>
          resolve(
            (method === "listSubscriptions" ? [mobile("sub-1", "user-1")] : fcmVault) as never
          )
      })
      repo[method].mockImplementation(() => query)
      const context = service.createSendContext()
      const first = service.send(input, context)
      await vi.waitFor(() => expect(repo[method]).toHaveBeenCalledOnce())
      const controller = new AbortController()
      const second = service.send(input, context, controller.signal)
      const rejected = expect(second).rejects.toThrow("cancel cached waiter")
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.abort(new Error("cancel cached waiter"))
      await rejected
      complete()
      await expect(first).resolves.toMatchObject({ sent: 1 })
      expect(repo[method]).toHaveBeenCalledOnce()
      expect(provider).toHaveBeenCalledOnce()
    }
  )

  it.each(["listSubscriptions", "loadCredentials", "deleteExpiredSubscriptions"] as const)(
    "observes late rejection after %s times out",
    async (method) => {
      const { service, repo, provider } = dbHarness(10)
      let rejectQuery!: (error: Error) => void
      repo[method].mockImplementation(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectQuery = reject
          })
      )
      if (method === "deleteExpiredSubscriptions") {
        provider.mockImplementation(
          async () => new Response(providerErrorBody("UNREGISTERED"), { status: 404 })
        )
      }
      await service.send(input, service.createSendContext())
      rejectQuery(new Error("late private database failure"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  )
})
