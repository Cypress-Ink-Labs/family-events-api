import { ConfigService } from "@nestjs/config"
import { describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import {
  MAX_PUSH_USER_IDS,
  type PushRepository,
  type PushSubscriptionRow,
  type PushVaultCredentials,
} from "./push.repository.js"
import { PushService, type PushServiceDependencies } from "./push.service.js"

function mobile(userId: string): PushSubscriptionRow {
  return {
    id: `subscription-${userId}`,
    userId,
    platform: "android",
    endpoint: null,
    token: `token-${userId}`,
    p256dh: null,
    authKey: null,
  }
}

const fcmCredentials: PushVaultCredentials = {
  fcm_service_account_json: JSON.stringify({
    project_id: "project",
    client_email: "push@example.com",
    private_key: "private-key",
  }),
}

function harness(
  dependencies: PushServiceDependencies = {},
  credentials: PushVaultCredentials = fcmCredentials
) {
  const repository = {
    listSubscriptions: vi.fn(async (userIds: string[]) => userIds.map(mobile)),
    loadCredentials: vi.fn(async () => credentials),
    deleteExpiredSubscriptions: vi.fn(async () => undefined),
  }
  const provider = vi.fn(async () => new Response(null, { status: 200 }))
  const service = new PushService(
    repository as unknown as PushRepository,
    { get: () => undefined } as unknown as ConfigService<Env, true>,
    {
      fetch: provider,
      getFcmAccessToken: async () => "access-token",
      ...dependencies,
    }
  )
  return { service, repository, provider }
}

async function webMaterial(): Promise<{
  credentials: PushVaultCredentials
  subscription: PushSubscriptionRow
}> {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
  const subscriber = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])
  const privateJwk = await crypto.subtle.exportKey("jwk", vapid.privateKey)
  return {
    credentials: {
      vapid_private_key: privateJwk.d!,
      vapid_public_key: Buffer.from(await crypto.subtle.exportKey("raw", vapid.publicKey)).toString(
        "base64url"
      ),
    },
    subscription: {
      ...mobile("user"),
      platform: "web",
      token: null,
      endpoint: "https://fcm.googleapis.com/wp/test",
      p256dh: Buffer.from(await crypto.subtle.exportKey("raw", subscriber.publicKey)).toString(
        "base64url"
      ),
      authKey: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
    },
  }
}

describe("push hardening integration", () => {
  it("deduplicates before chunking and continues after unknown subscription outcomes", async () => {
    const { service, repository, provider } = harness()
    const userIds = Array.from({ length: MAX_PUSH_USER_IDS + 1 }, (_, index) => `user-${index}`)
    repository.listSubscriptions.mockRejectedValueOnce(new Error("lookup unavailable"))

    const result = await service.send({ userIds: [...userIds, userIds[0]!], title: "T", body: "B" })

    expect(repository.listSubscriptions.mock.calls).toEqual([
      [userIds.slice(0, MAX_PUSH_USER_IDS)],
      [[userIds[MAX_PUSH_USER_IDS]]],
    ])
    expect(provider).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      requestedRecipients: MAX_PUSH_USER_IDS + 1,
      matchedRecipients: 1,
      unmatchedRecipients: 0,
      failedBatches: 1,
      failedBatchRecipients: MAX_PUSH_USER_IDS,
      sent: 1,
      failed: 0,
      skipped: 0,
      pruned: 0,
    })
  })

  it("reuses subscription caches for each chunk and one credential cache across sends", async () => {
    const { service, repository, provider } = harness()
    const userIds = Array.from({ length: MAX_PUSH_USER_IDS + 1 }, (_, index) => `user-${index}`)
    repository.listSubscriptions.mockImplementation(async (chunk) => [mobile(chunk[0]!)])
    const context = service.createSendContext()
    const input = { userIds, title: "First reminder", body: "B" }

    const first = await service.send(input, context)
    const second = await service.send({ ...input, title: "Second reminder" }, context)

    expect(first).toMatchObject({ sent: 2, failedBatches: 0 })
    expect(second).toEqual(first)
    expect(repository.listSubscriptions).toHaveBeenCalledTimes(2)
    expect(repository.loadCredentials).toHaveBeenCalledTimes(1)
    expect(provider).toHaveBeenCalledTimes(4)
    expect(context.subscriptions.size).toBe(2)
  })

  it.each(["web", "fcm"] as const)(
    "aborts every active %s request without dispatching remaining subscriptions or chunks",
    async (provider) => {
      const controller = new AbortController()
      const reason = new Error("scheduled job cancelled")
      const signals: AbortSignal[] = []
      let aborted = 0
      const request = vi.fn(
        async (_url: unknown, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            const signal = init!.signal!
            signals.push(signal)
            signal.addEventListener(
              "abort",
              () => {
                aborted++
                reject(signal.reason)
              },
              { once: true }
            )
            if (signals.length === 10) controller.abort(reason)
          })
      )
      const web = provider === "web" ? await webMaterial() : undefined
      const { service, repository } = harness(
        provider === "web" ? { guardedFetch: request } : { fetch: request },
        web?.credentials ?? fcmCredentials
      )
      repository.listSubscriptions.mockImplementation(async () =>
        Array.from({ length: 25 }, (_, index) => ({
          ...(web?.subscription ?? mobile("user-0")),
          id: `subscription-${index}`,
        }))
      )

      await expect(
        service.send(
          {
            userIds: Array.from({ length: MAX_PUSH_USER_IDS + 1 }, (_, index) => `user-${index}`),
            title: "T",
            body: "B",
          },
          undefined,
          controller.signal
        )
      ).rejects.toBe(reason)

      expect(request).toHaveBeenCalledTimes(10)
      expect(aborted).toBe(10)
      expect(signals.every((signal) => signal !== controller.signal && signal.aborted)).toBe(true)
      expect(repository.listSubscriptions).toHaveBeenCalledTimes(1)
      expect(repository.deleteExpiredSubscriptions).not.toHaveBeenCalled()
    }
  )
})
