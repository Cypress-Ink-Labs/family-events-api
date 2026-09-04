import { describe, expect, it } from "vitest"

import {
  buildApnsRequest,
  buildFcmEndpoint,
  buildFcmMessage,
  parseFcmServiceAccount,
} from "./mobile-push.js"

describe("mobile push helpers", () => {
  it("builds the legacy APNs alert payload against the selected fixed origin", () => {
    const request = buildApnsRequest({
      token: "device/token",
      jwt: "signed-jwt",
      bundleId: "com.example.family",
      environment: "sandbox",
      payload: { title: "Tonight", body: "Storytime at 6", url: "/events/1" },
    })

    expect(request).toEqual({
      url: "https://api.sandbox.push.apple.com/3/device/device%2Ftoken",
      headers: {
        authorization: "bearer signed-jwt",
        "apns-topic": "com.example.family",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aps: {
          alert: { title: "Tonight", body: "Storytime at 6" },
          sound: "default",
        },
        url: "/events/1",
      }),
    })
  })

  it("builds the legacy FCM notification, data, and Android channel payload", () => {
    expect(
      buildFcmMessage({
        token: "device-token",
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
    const endpoint = new URL(buildFcmEndpoint("family/events?redirect=https://example.com"))
    expect(endpoint.origin).toBe("https://fcm.googleapis.com")
    expect(endpoint.pathname).toContain("family%2Fevents%3Fredirect%3Dhttps%3A%2F%2Fexample.com")
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
