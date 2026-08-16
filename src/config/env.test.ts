import { describe, expect, it } from "vitest"

import { validateEnv } from "./env.js"

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

  it("passes cutover flags through as raw strings for flags.ts semantics", () => {
    const env = validateEnv({ ...base, CUTOVER_SCRAPE: "true", CUTOVER_TAG: "false" })
    expect(env.CUTOVER_SCRAPE).toBe("true")
    expect(env.CUTOVER_TAG).toBe("false")
    expect(env.CUTOVER_NOTIFY).toBeUndefined()
  })
})
