import { ConfigService } from "@nestjs/config"

import { DbService } from "../../src/db/db.service.js"

/**
 * Integration tests are DESTRUCTIVE: they drop/create schema objects and
 * TRUNCATE ... CASCADE between cases. This factory is the single entry point
 * for integration-test connections and refuses anything that does not look
 * like a disposable database:
 *
 * - loopback hosts only (127.0.0.1 / localhost / ::1), and
 * - never port 55322 (the shared local Supabase stack used by the app and
 *   backend repos — real dev data lives there).
 *
 * Set INTEGRATION_ALLOW_UNSAFE_DB=true to bypass, e.g. for a dedicated
 * ephemeral database that happens to be remote.
 */
export function integrationDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres"
  if (process.env.INTEGRATION_ALLOW_UNSAFE_DB === "true") return url
  const parsed = new URL(url)
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
  if (!loopback) {
    throw new Error(
      `refusing destructive integration tests against non-loopback host "${parsed.hostname}"; ` +
        "use a disposable local database or set INTEGRATION_ALLOW_UNSAFE_DB=true"
    )
  }
  if (parsed.port === "55322") {
    throw new Error(
      "refusing destructive integration tests against port 55322 (shared local Supabase stack); " +
        "point DATABASE_URL at a disposable database"
    )
  }
  return url
}

export function createIntegrationDb(): DbService {
  return new DbService(
    new ConfigService({
      DATABASE_URL: integrationDatabaseUrl(),
    }) as unknown as ConfigService<never, true>
  )
}
