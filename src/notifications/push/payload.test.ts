import { describe, expect, it } from "vitest"

import { boundedPushPayload, MAX_PUSH_PAYLOAD_BYTES } from "./payload.js"

describe("push payload byte budget", () => {
  it("bounds serialized Web Push including JSON escapes and keeps the URL unchanged", () => {
    const url = "https://events.example.com/events/🎉"
    const payload = boundedPushPayload(
      '🌍"\\'.repeat(3000),
      "家族🎉\n".repeat(3000),
      (title, body) => ({ title, body, url })
    )
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(
      MAX_PUSH_PAYLOAD_BYTES
    )
    expect(payload.url).toBe(url)
    expect(Buffer.from(payload.title, "utf8").toString("utf8")).toBe(payload.title)
    expect(Buffer.from(payload.body, "utf8").toString("utf8")).toBe(payload.body)
    expect(payload.title).not.toBe("")
    expect(payload.body).not.toBe("")
  })
})
