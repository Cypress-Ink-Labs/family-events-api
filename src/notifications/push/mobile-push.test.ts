import { describe, expect, it } from "vitest"

import {
  buildFcmEndpoint,
  buildFcmMessage,
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
})
