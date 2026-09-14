import { readFile } from "node:fs/promises"
import path from "node:path"
import { Client } from "pg"

const TEST_FILES = ["source_details_freshness.sql", "admission_cost.sql"] as const

export function validateSchemaTestDatabaseUrl(databaseUrl: string, allowSharedPort = false): void {
  const parsed = new URL(databaseUrl)
  if (parsed.port === "55322" && !allowSharedPort) {
    throw new Error(
      "refusing PostgreSQL regression tests against shared port 55322; use a dedicated test database"
    )
  }
}

function executableSql(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("\\set "))
    .join("\n")
}

export async function runSchemaTests(databaseUrl: string, allowSharedPort = false): Promise<void> {
  validateSchemaTestDatabaseUrl(databaseUrl, allowSharedPort)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    for (const filename of TEST_FILES) {
      const sql = await readFile(path.resolve("schema/tests", filename), "utf8")
      try {
        await client.query(executableSql(sql))
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw new Error(`PostgreSQL regression suite failed: ${filename}`, { cause: error })
      }
      console.log(`PostgreSQL regression suite passed: ${filename}`)
    }
  } finally {
    await client.end()
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL
  if (!databaseUrl) {
    console.log("Skipping PostgreSQL regression suites: TEST_DATABASE_URL is not set")
    return
  }
  await runSchemaTests(databaseUrl, process.env.CI === "true")
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "PostgreSQL regression suite failed")
    process.exitCode = 1
  })
}
