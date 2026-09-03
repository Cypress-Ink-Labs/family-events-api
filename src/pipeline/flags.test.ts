import { describe, expect, it } from "vitest"

import { cutoverFlagName, enabledFamilies, isFamilyEnabled } from "./flags.js"

// Ported from the U12 worker's flag semantics: production fails closed
// (exact "true" required), non-production fails open (unless exact "false").

describe("cutoverFlagName", () => {
  it("maps a family to its env var", () => {
    expect(cutoverFlagName("scrape")).toBe("CUTOVER_SCRAPE")
    expect(cutoverFlagName("notify")).toBe("CUTOVER_NOTIFY")
  })
})

describe("isFamilyEnabled", () => {
  it("production requires the exact string true", () => {
    expect(isFamilyEnabled("scrape", { NODE_ENV: "production", CUTOVER_SCRAPE: "true" })).toBe(true)
    expect(isFamilyEnabled("scrape", { NODE_ENV: "production", CUTOVER_SCRAPE: "TRUE" })).toBe(
      false
    )
    expect(isFamilyEnabled("scrape", { NODE_ENV: "production", CUTOVER_SCRAPE: "1" })).toBe(false)
    expect(isFamilyEnabled("scrape", { NODE_ENV: "production" })).toBe(false)
    expect(isFamilyEnabled("digest", { NODE_ENV: "production", CUTOVER_DIGEST: "true" })).toBe(true)
    expect(
      isFamilyEnabled("reminders", { NODE_ENV: "production", CUTOVER_REMINDERS: "true" })
    ).toBe(true)
  })

  it("non-production is enabled unless the exact string false", () => {
    expect(isFamilyEnabled("tag", {})).toBe(true)
    expect(isFamilyEnabled("tag", { CUTOVER_TAG: "false" })).toBe(false)
    expect(isFamilyEnabled("tag", { NODE_ENV: "test", CUTOVER_TAG: "0" })).toBe(true)
  })
})

describe("enabledFamilies", () => {
  it("boots nothing in production without flags (single-writer rule)", () => {
    expect(enabledFamilies({ NODE_ENV: "production" })).toEqual([])
  })

  it("enables only the flagged families in production", () => {
    expect(
      enabledFamilies({ NODE_ENV: "production", CUTOVER_SCRAPE: "true", CUTOVER_NOTIFY: "true" })
    ).toEqual(["scrape", "notify"])
  })

  it("enables everything by default outside production", () => {
    expect(enabledFamilies({})).toHaveLength(6)
  })
})
