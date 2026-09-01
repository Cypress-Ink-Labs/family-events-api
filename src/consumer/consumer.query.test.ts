import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { parseMapQuery, parsePlanQuery } from "./consumer.query.js"

describe("parseMapQuery", () => {
  it("accepts an optional city_id", () => {
    expect(parseMapQuery({})).toEqual({ cityId: null })
    expect(parseMapQuery({ city_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).toEqual({
      cityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    })
  })

  it("rejects invalid or unknown query parameters", () => {
    expect(() => parseMapQuery({ city_id: "not-a-uuid" })).toThrow(BadRequestException)
    expect(() => parseMapQuery({ limit: "999" })).toThrow(BadRequestException)
  })
})

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
