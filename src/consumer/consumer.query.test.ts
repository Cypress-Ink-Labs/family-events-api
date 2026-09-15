import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { parseExploreQuery, parseMapQuery, parsePlanQuery } from "./consumer.query.js"

describe("parseMapQuery", () => {
  it("parses conjunctive family needs with an explicit unknown opt-in", () => {
    expect(
      parseMapQuery({
        family_needs: "indoor,outdoor,wheelchair_accessible",
        include_unknown_family_needs: "true",
      })
    ).toMatchObject({
      familyNeeds: ["indoor", "outdoor", "wheelchair_accessible"],
      includeUnknownFamilyNeeds: true,
    })
  })

  it("rejects duplicate, unsupported, and unscoped unknown family-needs choices", () => {
    expect(() => parseMapQuery({ family_needs: "indoor,indoor" })).toThrow()
    expect(() => parseMapQuery({ family_needs: "parking" })).toThrow()
    expect(() => parseMapQuery({ include_unknown_family_needs: "true" })).toThrow()
  })

  it("defaults to weekend and accepts city/date/age choices", () => {
    expect(parseMapQuery({})).toEqual({
      cityId: null,
      range: "weekend",
      ages: [],
      ageMode: "all",
      includeUnknownAge: false,
      cost: "any",
    })
    expect(
      parseMapQuery({
        city_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        range: "today",
      })
    ).toEqual({
      cityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      range: "today",
      ages: [],
      ageMode: "all",
      includeUnknownAge: false,
      cost: "any",
    })
  })

  it("rejects invalid or unknown query parameters", () => {
    expect(() => parseMapQuery({ city_id: "not-a-uuid" })).toThrow(BadRequestException)
    expect(() => parseMapQuery({ limit: "999" })).toThrow(BadRequestException)
  })

  it("uses the same multiple-age query contract as Explore", () => {
    expect(parseMapQuery({ ages: "2,7", age_mode: "any", include_unknown_age: "true" })).toEqual({
      cityId: null,
      range: "weekend",
      ages: [2, 7],
      ageMode: "any",
      includeUnknownAge: true,
      cost: "any",
    })
  })
})

describe("parseExploreQuery", () => {
  it("defaults discovery to this weekend and accepts one-tap alternatives", () => {
    expect(parseExploreQuery({})).toMatchObject({ range: "weekend", cost: "any" })
    expect(parseExploreQuery({ range: "today" })).toMatchObject({ range: "today" })
    expect(parseExploreQuery({ range: "upcoming" })).toMatchObject({ range: "upcoming" })
    expect(() => parseExploreQuery({ range: "later" })).toThrow(BadRequestException)
  })

  it("parses explicit admission states without treating legacy false as paid", () => {
    expect(parseExploreQuery({ cost: "free" })).toMatchObject({ cost: "free", isFree: null })
    expect(parseExploreQuery({ cost: "paid" })).toMatchObject({ cost: "paid", isFree: null })
    expect(parseExploreQuery({ cost: "unknown" })).toMatchObject({ cost: "unknown", isFree: null })
    expect(parseExploreQuery({ is_free: "false" })).toMatchObject({
      cost: "any",
      isFree: false,
    })
    expect(() => parseExploreQuery({ cost: "paid", is_free: "false" })).toThrow(
      "cost cannot be combined"
    )
  })

  it("keeps legacy explicit date bounds and rejects combining them with range", () => {
    expect(parseExploreQuery({ date_from: "2026-08-01T00:00:00Z" })).toMatchObject({
      range: null,
      dateFrom: "2026-08-01T00:00:00Z",
      dateTo: null,
    })
    expect(() =>
      parseExploreQuery({ range: "weekend", date_from: "2026-08-01T00:00:00Z" })
    ).toThrow("range cannot be combined")
  })

  it("rejects a keyword over the legacy 100-character cap", () => {
    expect(() => parseExploreQuery({ keyword: "x".repeat(101) })).toThrow(BadRequestException)
    expect(() => parseExploreQuery({ keyword: "x".repeat(100) })).not.toThrow()
  })

  it("defaults an empty age selection to every-child matching without unknowns", () => {
    expect(parseExploreQuery({})).toMatchObject({
      ages: [],
      ageMode: "all",
      includeUnknownAge: false,
    })
  })

  it("parses multiple ages and the explicit any-child and unknown alternatives", () => {
    expect(
      parseExploreQuery({ ages: "2,7", age_mode: "any", include_unknown_age: "true" })
    ).toMatchObject({
      ages: [2, 7],
      ageMode: "any",
      includeUnknownAge: true,
    })
  })

  it.each([
    { ages: "" },
    { ages: "2," },
    { ages: "2.5" },
    { ages: "-1" },
    { ages: "18" },
    { ages: "2,2" },
    { ages: "0,1,2,3,4,5,6,7,8,9,10" },
    { age_mode: "any" },
    { include_unknown_age: "true" },
    { ages: "2", kid_age: "2" },
  ])("rejects malformed or contradictory age query %#", (query) => {
    expect(() => parseExploreQuery(query)).toThrow(BadRequestException)
  })

  it("keeps the legacy single kid_age query backward compatible", () => {
    expect(parseExploreQuery({ kid_age: "4" })).toMatchObject({
      ages: [4],
      ageMode: "all",
      includeUnknownAge: false,
    })
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
