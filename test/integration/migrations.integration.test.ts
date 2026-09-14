import { randomUUID } from "node:crypto"
import { Client } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { applyMigrations } from "../../scripts/migrations"

const databaseUrl = process.env.TEST_DATABASE_URL
const describeDatabase = databaseUrl ? describe : describe.skip

describeDatabase("migration runner integration", () => {
  const schema = `migration_test_${randomUUID().replaceAll("-", "")}`
  const client = new Client({ connectionString: databaseUrl })

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await client.query("DELETE FROM private.api_schema_migrations WHERE version = $1", [
      "20990101000000",
    ])
    await client.end()
  })

  it("commits migration SQL and ledger atomically", async () => {
    await client.connect()
    const migration = {
      version: "20990101000000",
      filename: "20990101000000_integration.sql",
      checksum: "integration",
      sql: `CREATE SCHEMA ${schema}`,
    }
    const migrations = [migration]
    expect(await applyMigrations(client, migrations)).toEqual([migration.version])
    expect(await applyMigrations(client, migrations)).toEqual([])
    expect((await client.query("SELECT to_regnamespace($1) AS name", [schema])).rows[0].name).toBe(
      schema
    )
  })
})
