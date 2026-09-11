import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import {
  encodeDeadLetterCursor,
  parseDeadLetterListQuery,
  parseDeadLetterPath,
  parseEmptyDeadLetterBody,
} from "./admin-dead-letter.input.js"

describe("admin dead-letter input", () => {
  it("applies the default limit and round-trips nullable timestamp cursors", () => {
    const cursor = encodeDeadLetterCursor({ finishedAt: null, id: "9007199254740993" })
    expect(parseDeadLetterListQuery({ queue: "tag", cursor })).toEqual({
      queue: "tag",
      limit: 25,
      cursor: { finishedAt: null, id: "9007199254740993" },
    })
  })

  it.each([
    { queue: "review" },
    { queue: "source", limit: "0" },
    { queue: "tag", limit: "51" },
    { queue: "tag", cursor: "not a cursor" },
    { queue: "source", extra: "no" },
  ])("rejects a non-contract query: %o", (query) => {
    expect(() => parseDeadLetterListQuery(query)).toThrow(BadRequestException)
  })

  it("keeps canonical decimal path IDs as strings", () => {
    expect(parseDeadLetterPath("source", "9223372036854775807")).toEqual({
      queue: "source",
      id: "9223372036854775807",
    })
    expect(() => parseDeadLetterPath("source", "01")).toThrow(BadRequestException)
  })

  it("accepts only absent or empty mutation bodies", () => {
    expect(parseEmptyDeadLetterBody(undefined)).toBeUndefined()
    expect(parseEmptyDeadLetterBody({})).toBeUndefined()
    expect(() => parseEmptyDeadLetterBody({ actor: "spoof" })).toThrow(BadRequestException)
  })
})
