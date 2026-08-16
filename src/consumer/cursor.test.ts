import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { decodeCursor, encodeCursor } from "./cursor.js"

const CURSOR = {
  startDatetime: "2026-08-16T15:00:00.123456+00:00",
  id: "11111111-1111-4111-8111-111111111111",
}

describe("event cursor codec", () => {
  it("round-trips the repository cursor through the snake_case wire shape", () => {
    const encoded = encodeCursor(CURSOR)

    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      after_start: CURSOR.startDatetime,
      after_id: CURSOR.id,
    })
    expect(decodeCursor(encoded)).toEqual(CURSOR)
  })

  it.each([
    ["empty", ""],
    ["non-base64", "%%%"],
    ["non-JSON", Buffer.from("not json").toString("base64")],
    ["missing field", Buffer.from(JSON.stringify({ after_id: CURSOR.id })).toString("base64")],
    [
      "invalid timestamp",
      Buffer.from(JSON.stringify({ after_start: "yesterday", after_id: CURSOR.id })).toString(
        "base64"
      ),
    ],
    [
      "invalid id",
      Buffer.from(
        JSON.stringify({ after_start: CURSOR.startDatetime, after_id: "not-a-uuid" })
      ).toString("base64"),
    ],
    [
      "extra field",
      Buffer.from(
        JSON.stringify({ after_start: CURSOR.startDatetime, after_id: CURSOR.id, extra: true })
      ).toString("base64"),
    ],
  ])("rejects a %s cursor", (_case, encoded) => {
    expect(() => decodeCursor(encoded)).toThrow(BadRequestException)
  })
})
