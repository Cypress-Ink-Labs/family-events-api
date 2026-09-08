import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { AdminAccessDeniedError } from "./admin-database.js"
import { AdminUserRepository } from "./admin-user.repository.js"

const ACTOR = "11111111-1111-4111-8111-111111111111"
const USER = "22222222-2222-4222-8222-222222222222"

function setup() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql === "SELECT private.is_admin() AS allowed") return { rows: [{ allowed: true }] }
    return { rows: [{ user_id: USER }] }
  })
  const withTransaction = vi.fn(async (work: (client: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient)
  )
  return {
    query,
    repository: new AdminUserRepository({ withTransaction } as unknown as DbService),
  }
}

describe("AdminUserRepository", () => {
  it("authorizes direct reads under transaction-local actor claims", async () => {
    const { query, repository } = setup()
    await repository.list(ACTOR)
    expect(query.mock.calls[0]).toEqual([
      "SELECT set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: ACTOR, role: "authenticated" })],
    ])
    expect(query.mock.calls[1]).toEqual(["SELECT private.is_admin() AS allowed"])
    expect(query.mock.calls[2]![0]).toContain("LEFT JOIN public.user_profiles")
  })

  it("denies direct reads unless private.is_admin returns true", async () => {
    const { query, repository } = setup()
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ allowed: false }] })
    await expect(repository.list(ACTOR)).rejects.toBeInstanceOf(AdminAccessDeniedError)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("binds target access values and reloads the joined record", async () => {
    const { query, repository } = setup()
    await repository.setAccess(ACTOR, USER, { isEnabled: false, disabledReason: "quote '" })
    expect(query.mock.calls[1]).toEqual([
      "SELECT public.admin_set_user_access($1::uuid, $2::boolean, $3::text)",
      [USER, false, "quote '"],
    ])
    expect(query.mock.calls[2]![1]).toEqual([USER])
  })

  it("calls delete with only trusted actor claims and a bound target", async () => {
    const { query, repository } = setup()
    await repository.delete(ACTOR, USER)
    expect(query.mock.calls[1]).toEqual(["SELECT public.admin_delete_user($1::uuid)", [USER]])
  })
})
