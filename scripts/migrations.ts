import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Client } from "pg"

export const MIGRATION_SCHEMA = "private"
export const MIGRATION_TABLE = "api_schema_migrations"
export const MIGRATION_LOCK_KEY = 1_180_030_017
const FORWARD_FILE = /^(\d{14})_[a-z0-9_]+\.sql$/
const TRANSACTION_CONTROL = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im

export interface Migration {
  version: string
  filename: string
  checksum: string
  sql: string
}

export interface Queryable {
  query(queryText: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
  const forward = filenames
    .filter((filename) => !filename.endsWith("_down.sql") && FORWARD_FILE.test(filename))
    .toSorted()
  const unexpected = filenames.filter(
    (filename) => !FORWARD_FILE.test(filename) && !filename.endsWith("_down.sql")
  )
  if (unexpected.length > 0)
    throw new Error(`Invalid migration filename(s): ${unexpected.join(", ")}`)

  const migrations = await Promise.all(
    forward.map(async (filename) => {
      const match = FORWARD_FILE.exec(filename)
      if (!match) throw new Error(`Invalid migration filename: ${filename}`)
      const version = match[1]!
      const rollback = filename.replace(/\.sql$/, "_down.sql")
      if (!filenames.includes(rollback)) throw new Error(`Missing rollback file for ${filename}`)
      const sql = await readFile(path.join(directory, filename), "utf8")
      const rollbackSql = await readFile(path.join(directory, rollback), "utf8")
      if (TRANSACTION_CONTROL.test(sql)) {
        throw new Error(
          `${filename} contains transaction control; the migration runner owns the transaction`
        )
      }
      if (TRANSACTION_CONTROL.test(rollbackSql)) {
        throw new Error(
          `${rollback} contains transaction control; the migration operator owns the transaction`
        )
      }
      return {
        version,
        filename,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      }
    })
  )
  const versions = new Set<string>()
  for (const migration of migrations) {
    if (versions.has(migration.version))
      throw new Error(`Duplicate migration version ${migration.version}`)
    versions.add(migration.version)
  }
  return migrations
}

async function beginLocked(client: Queryable): Promise<void> {
  await client.query("BEGIN")
  await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY])
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${MIGRATION_SCHEMA}`)
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_SCHEMA}.${MIGRATION_TABLE} (
      version text PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

async function reconcile(client: Queryable, migrations: Migration[]): Promise<Set<string>> {
  const result = await client.query(
    `SELECT version, filename, checksum FROM ${MIGRATION_SCHEMA}.${MIGRATION_TABLE} ORDER BY version`
  )
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]))
  for (const row of result.rows) {
    const version = String(row.version)
    const local = byVersion.get(version)
    if (!local) throw new Error(`Applied migration ${version} is missing from the repository`)
    if (row.filename !== local.filename || row.checksum !== local.checksum) {
      throw new Error(`Applied migration ${version} has drifted from the repository`)
    }
  }
  return new Set(result.rows.map((row) => String(row.version)))
}

export async function applyMigrations(
  client: Queryable,
  migrations: Migration[]
): Promise<string[]> {
  const appliedNow: string[] = []
  try {
    await beginLocked(client)
    let applied = await reconcile(client, migrations)
    await client.query("COMMIT")

    for (const migration of migrations) {
      await beginLocked(client)
      applied = await reconcile(client, migrations)
      if (!applied.has(migration.version)) {
        await client.query(migration.sql)
        await client.query(
          `INSERT INTO ${MIGRATION_SCHEMA}.${MIGRATION_TABLE} (version, filename, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.filename, migration.checksum]
        )
        appliedNow.push(migration.version)
      }
      await client.query("COMMIT")
    }
    return appliedNow
  } catch (error) {
    try {
      await client.query("ROLLBACK")
    } catch {
      // Preserve the migration error if the connection is already unusable.
    }
    throw error
  }
}

export async function runMigrations(databaseUrl: string, directory: string): Promise<string[]> {
  const migrations = await loadMigrations(directory)
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await applyMigrations(client, migrations)
  } finally {
    await client.end()
  }
}
