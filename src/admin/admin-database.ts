import type { PoolClient } from "pg"

import type { DbService } from "../db/db.service.js"

export class AdminAccessDeniedError extends Error {
  constructor() {
    super("database admin access denied")
    this.name = "AdminAccessDeniedError"
  }
}

export function withAdminActor<T>(
  db: DbService,
  actor: string,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  return db.withTransaction(async (client) => {
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: actor, role: "authenticated" }),
    ])
    return work(client)
  })
}

export async function requireDatabaseAdmin(client: PoolClient): Promise<void> {
  const result = await client.query<{ allowed: boolean | null }>(
    "SELECT private.is_admin() AS allowed"
  )
  if (result.rows[0]?.allowed !== true) throw new AdminAccessDeniedError()
}

export function isDatabaseAdminDenial(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const failure = error as { code?: unknown; message?: unknown }
  return (
    error instanceof AdminAccessDeniedError ||
    failure.code === "42501" ||
    failure.message === "ADMIN_EVENT_ADMIN_REQUIRED" ||
    failure.message === "ADMIN_SOURCE_ADMIN_REQUIRED" ||
    failure.message === "ADMIN_USER_ACCESS_ADMIN_REQUIRED" ||
    failure.message === "forbidden"
  )
}
