import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { parsePlanQuery } from "./consumer.query.js"

describe("parsePlanQuery", () => {
  it("defaults city and age to null", () => {
    expect(parsePlanQuery({})).toEqual({ cityId: null, kidAge: null })
  })

  it("parses city_id and kid_age", () => {
    expect(
      parsePlanQuery({
        city_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        kid_age: "4",
      })
    ).toEqual({
      cityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      kidAge: 4,
    })
  })

  it("rejects an invalid city_id", () => {
    expect(() => parsePlanQuery({ city_id: "not-a-uuid" })).toThrow(BadRequestException)
  })
})
