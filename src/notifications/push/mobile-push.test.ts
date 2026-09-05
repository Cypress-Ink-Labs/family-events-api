import { describe, expect, it, vi } from "vitest"

import {
  buildFcmEndpoint,
  buildFcmMessage,
  getFcmAccessToken,
  isFcmUnregisteredResponse,
  parseFcmServiceAccount,
} from "./mobile-push.js"

describe("mobile push helpers", () => {
  it("adds Android options only for Android FCM tokens", () => {
    expect(
      buildFcmMessage({
        token: "device-token",
        platform: "android",
        title: "Tomorrow",
        body: "Museum opens at 9",
        url: "/events/2",
      })
    ).toEqual({
      message: {
        token: "device-token",
        notification: { title: "Tomorrow", body: "Museum opens at 9" },
        data: { url: "/events/2" },
        android: {
          priority: "HIGH",
          notification: { channel_id: "family_events" },
        },
      },
    })
  })

  it("adds APNs payload options only for iOS FCM tokens", () => {
    expect(
      buildFcmMessage({
        token: "ios-token",
        platform: "ios",
        title: "Tomorrow",
        body: "Museum opens at 9",
        url: "/events/2",
      })
    ).toEqual({
      message: {
        token: "ios-token",
        notification: { title: "Tomorrow", body: "Museum opens at 9" },
        data: { url: "/events/2" },
        apns: { payload: { aps: { sound: "default" } } },
      },
    })

    const endpoint = new URL(buildFcmEndpoint("family/events?redirect=https://example.com"))
    expect(endpoint.origin).toBe("https://fcm.googleapis.com")
    expect(endpoint.pathname).toContain("family%2Fevents%3Fredirect%3Dhttps%3A%2F%2Fexample.com")
  })

  it("recognizes only explicit FCM UNREGISTERED provider details", async () => {
    await expect(
      isFcmUnregisteredResponse(
        new Response(JSON.stringify({ error: { details: [{ errorCode: "UNREGISTERED" }] } }), {
          status: 404,
        })
      )
    ).resolves.toBe(true)
    await expect(
      isFcmUnregisteredResponse(
        new Response(JSON.stringify({ error: { details: [{ errorCode: "INVALID_ARGUMENT" }] } }), {
          status: 400,
        })
      )
    ).resolves.toBe(false)
  })

  it("parses complete FCM service account credentials and rejects incomplete shapes", () => {
    expect(
      parseFcmServiceAccount(
        JSON.stringify({
          project_id: "family-events",
          client_email: "push@example.iam.gserviceaccount.com",
          private_key: "private-key",
        })
      )
    ).toEqual({
      projectId: "family-events",
      clientEmail: "push@example.iam.gserviceaccount.com",
      privateKey: "private-key",
    })
    expect(parseFcmServiceAccount(" ")).toBeUndefined()
    expect(parseFcmServiceAccount('{"project_id":"only"}')).toBeUndefined()
    expect(() => parseFcmServiceAccount("not-json")).toThrow()
  })

  it("signs and exchanges a verifiable RS256 OAuth assertion", async () => {
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )
    const privatePkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey)
    const encoded = Buffer.from(privatePkcs8)
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as URLSearchParams
      const assertion = form.get("assertion")!
      const [header, payload, signature] = assertion.split(".")
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as {
        iss: string
        aud: string
        scope: string
        iat: number
        exp: number
      }
      expect(claims).toMatchObject({
        iss: "push@example.iam.gserviceaccount.com",
        aud: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/firebase.messaging",
      })
      expect(claims.exp - claims.iat).toBe(3600)
      await expect(
        crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          keys.publicKey,
          Buffer.from(signature!, "base64url"),
          new TextEncoder().encode(`${header}.${payload}`)
        )
      ).resolves.toBe(true)
      return new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 })
    })

    await expect(
      getFcmAccessToken(
        {
          projectId: "family-events",
          clientEmail: "push@example.iam.gserviceaccount.com",
          privateKey: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
        },
        {
          fetch: fetchMock as typeof fetch,
          now: () => Date.parse("2026-09-04T12:00:00.000Z"),
        }
      )
    ).resolves.toBe("access-token")
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" })
    )
  })
})
