import path from "node:path"
import { runMigrations } from "./migrations"

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  const applied = await runMigrations(databaseUrl, path.resolve("schema/migrations"))
  console.log(
    applied.length === 0 ? "Database schema is current" : `Applied ${applied.length} migration(s)`
  )
}

main().catch((error: unknown) => {
  // Driver errors can contain connection details. Keep the CLI's failure output
  // credential-free; detailed diagnosis belongs in a secured operator session.
  console.error(error instanceof Error ? `Migration failed (${error.name})` : "Migration failed")
  process.exitCode = 1
})
