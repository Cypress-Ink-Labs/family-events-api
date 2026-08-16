import { describe, expect, it } from "vitest"

import { cutoverFamilies, validateEnv } from "./env.js"

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" }

describe("validateEnv", () => {
  it("applies defaults", () => {
    const env = validateEnv(base)
    expect(env.PORT).toBe(3001)
    expect(env.NODE_ENV).toBe("development")
    expect(env.PGBOSS_SCHEMA).toBe("pgboss")
  })

  it("rejects a missing DATABASE_URL with a readable message", () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/)
  })

  it("coerces PORT from string", () => {
    expect(validateEnv({ ...base, PORT: "8080" }).PORT).toBe(8080)
  })

  it("rejects a non-numeric PORT", () => {
    expect(() => validateEnv({ ...base, PORT: "abc" })).toThrow(/PORT/)
  })
})

describe("cutoverFamilies", () => {
  it("parses a comma-separated list, trimmed and lowercased", () => {
    const env = validateEnv({ ...base, CUTOVER_FAMILIES: " Smith, jones ,DOE " })
    expect(cutoverFamilies(env)).toEqual(new Set(["smith", "jones", "doe"]))
  })

  it("returns an empty set when unset (no family gets provisioned)", () => {
    expect(cutoverFamilies(validateEnv(base)).size).toBe(0)
  })
})
