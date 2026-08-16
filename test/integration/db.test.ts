import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { integrationDatabaseUrl } from "./db.js"

const ORIGINAL_ENV = { ...process.env }

describe("integrationDatabaseUrl guard", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.INTEGRATION_ALLOW_UNSAFE_DB
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it("allows a loopback database", () => {
    process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/anything"
    expect(integrationDatabaseUrl()).toContain("127.0.0.1")
  })

  it("refuses a non-loopback host", () => {
    process.env.DATABASE_URL = "postgresql://u:p@db.prod.example.com:5432/postgres"
    expect(() => integrationDatabaseUrl()).toThrow(/non-loopback/)
  })

  it("refuses the shared local Supabase stack on port 55322", () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:55322/postgres"
    expect(() => integrationDatabaseUrl()).toThrow(/55322/)
  })

  it("honors the explicit unsafe override", () => {
    process.env.DATABASE_URL = "postgresql://u:p@db.remote.example.com:5432/ephemeral"
    process.env.INTEGRATION_ALLOW_UNSAFE_DB = "true"
    expect(integrationDatabaseUrl()).toContain("db.remote.example.com")
  })
})
