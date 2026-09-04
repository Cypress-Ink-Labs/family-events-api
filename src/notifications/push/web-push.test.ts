import { describe, expect, it } from "vitest"

import { isTrustedWebPushEndpoint } from "./web-push.js"

describe("isTrustedWebPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/send/1",
    "https://updates.push.services.mozilla.com/wpush/v2/1",
    "https://web.push.apple.com/Q123",
    "https://db5.notify.windows.com/w/?token=1",
  ])("accepts trusted HTTPS push provider endpoint %s", (endpoint) => {
    expect(isTrustedWebPushEndpoint(endpoint)).toBe(true)
  })

  it.each([
    "http://fcm.googleapis.com/send/1",
    "https://evil-fcm.googleapis.com/send/1",
    "https://notify.windows.com/w/1",
    "https://db5.notify.windows.com.evil.example/w/1",
    "https://127.0.0.1/private",
    "not-a-url",
  ])("rejects untrusted web push endpoint %s", (endpoint) => {
    expect(isTrustedWebPushEndpoint(endpoint)).toBe(false)
  })
})
