import { describe, expect, it } from "vitest"

import { decodeEventCursor, encodeEventCursor } from "./cursor.js"

const START = "2026-08-16T14:00:00.123456+00:00"
const ID = "0b6a3f5e-1111-4222-8333-444455556666"

describe("event list cursor", () => {
  it("round-trips start_datetime + id", () => {
    expect(decodeEventCursor(encodeEventCursor(START, ID))).toEqual({
      afterStart: START,
      afterId: ID,
    })
  })

  it("rejects malformed base64", () => {
    expect(decodeEventCursor("not-base64!!!")).toBeNull()
  })

  it("rejects a payload missing after_id", () => {
    const raw = Buffer.from(JSON.stringify({ after_start: START }), "utf8").toString("base64")
    expect(decodeEventCursor(raw)).toBeNull()
  })

  it("rejects a non-uuid after_id", () => {
    expect(decodeEventCursor(encodeEventCursor(START, "not-a-uuid"))).toBeNull()
  })

  it("rejects a non-datetime after_start", () => {
    const raw = Buffer.from(JSON.stringify({ after_start: "soon", after_id: ID }), "utf8").toString(
      "base64"
    )
    expect(decodeEventCursor(raw)).toBeNull()
  })
})
