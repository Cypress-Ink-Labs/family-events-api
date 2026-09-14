import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { applyMigrations, loadMigrations, type Queryable } from "../scripts/migrations"
import { validateSchemaTestDatabaseUrl } from "../scripts/run-schema-tests"

class FakeClient implements Queryable {
  readonly calls: Array<{ text: string; values?: unknown[] }> = []
  rows: Record<string, unknown>[] = []
  failSql = false

  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values })
    if (this.failSql && text === "SELECT 42") throw new Error("migration failed")
    if (text.startsWith("SELECT version")) return { rows: this.rows }
    if (text.startsWith("INSERT INTO")) {
      this.rows.push({ version: values![0], filename: values![1], checksum: values![2] })
    }
    return { rows: [] }
  }
}

describe("migration ownership", () => {
  it("reserves the shared local Supabase port for explicit CI use", () => {
    const shared = "postgresql://postgres:postgres@127.0.0.1:55322/postgres"
    expect(() => validateSchemaTestDatabaseUrl(shared)).toThrow("shared port 55322")
    expect(() => validateSchemaTestDatabaseUrl(shared, true)).not.toThrow()
  })

  it("loads every repository migration with its rollback", async () => {
    const migrations = await loadMigrations(path.resolve("schema/migrations"))
    expect(migrations.map(({ version }) => version)).toEqual(["20260902002000", "20260902003000"])
  })

  it("requires a paired rollback and rejects embedded transactions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "api-migrations-"))
    await writeFile(
      path.join(directory, "20260902002000_example.sql"),
      "BEGIN;\nSELECT 1;\nCOMMIT;\n"
    )
    await writeFile(path.join(directory, "20260902002000_example_down.sql"), "SELECT 1;\n")
    await expect(loadMigrations(directory)).rejects.toThrow("runner owns the transaction")
  })

  it("applies SQL and its ledger row in one locked transaction, exactly once", async () => {
    const client = new FakeClient()
    const migration = {
      version: "20260902002000",
      filename: "20260902002000_example.sql",
      checksum: "abc",
      sql: "SELECT 42",
    }
    expect(await applyMigrations(client, [migration])).toEqual(["20260902002000"])
    expect(await applyMigrations(client, [migration])).toEqual([])
    expect(client.calls.filter((call) => call.text === "SELECT 42")).toHaveLength(1)
    expect(client.calls.some((call) => call.text.includes("pg_advisory_xact_lock"))).toBe(true)
  })

  it("rolls back a failed migration without recording it", async () => {
    const client = new FakeClient()
    client.failSql = true
    const migration = {
      version: "20260902002000",
      filename: "20260902002000_example.sql",
      checksum: "abc",
      sql: "SELECT 42",
    }
    await expect(applyMigrations(client, [migration])).rejects.toThrow("migration failed")
    expect(client.rows).toEqual([])
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK")
  })

  it("rejects missing applied migrations and checksum drift", async () => {
    const client = new FakeClient()
    client.rows = [{ version: "1", filename: "gone.sql", checksum: "abc" }]
    await expect(applyMigrations(client, [])).rejects.toThrow("missing from the repository")
    client.rows = [
      { version: "20260902002000", filename: "20260902002000_example.sql", checksum: "old" },
    ]
    await expect(
      applyMigrations(client, [
        {
          version: "20260902002000",
          filename: "20260902002000_example.sql",
          checksum: "new",
          sql: "SELECT 42",
        },
      ])
    ).rejects.toThrow("drifted")
  })
})
