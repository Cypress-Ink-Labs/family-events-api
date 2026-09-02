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

  it("treats OPENWEATHER_API_KEY as optional", () => {
    expect(validateEnv(base).OPENWEATHER_API_KEY).toBeUndefined()
    expect(validateEnv({ ...base, OPENWEATHER_API_KEY: "owm" }).OPENWEATHER_API_KEY).toBe("owm")
  })

  it("accepts an optional WEB_ORIGIN, normalizes a trailing slash, and rejects a non-URL", () => {
    expect(validateEnv(base).WEB_ORIGIN).toBeUndefined()
    expect(validateEnv({ ...base, WEB_ORIGIN: "https://events.example.com" }).WEB_ORIGIN).toBe(
      "https://events.example.com"
    )
    expect(validateEnv({ ...base, WEB_ORIGIN: "https://events.example.com/" }).WEB_ORIGIN).toBe(
      "https://events.example.com"
    )
    expect(() => validateEnv({ ...base, WEB_ORIGIN: "not a url" })).toThrow(/WEB_ORIGIN/)
  })

  it("passes cutover flags through as raw strings for flags.ts semantics", () => {
    const env = validateEnv({ ...base, CUTOVER_SCRAPE: "true", CUTOVER_TAG: "false" })
    expect(env.CUTOVER_SCRAPE).toBe("true")
    expect(env.CUTOVER_TAG).toBe("false")
    expect(env.CUTOVER_NOTIFY).toBeUndefined()
  })
})
