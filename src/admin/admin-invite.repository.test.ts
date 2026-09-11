import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { AdminAccessDeniedError } from "./admin-database.js"
import { AdminInviteRepository } from "./admin-invite.repository.js"

const ACTOR = "11111111-1111-4111-8111-111111111111"
const CODE = "22222222-2222-4222-8222-222222222222"

function setup() {
  const query = vi.fn(async (sql: string, _params?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (sql === "SELECT private.is_admin() AS allowed") return { rows: [{ allowed: true }] }
    if (sql.includes("invites_required")) return { rows: [{ required: true }] }
    if (sql.includes("admin_create_invite_code"))
      return {
        rows: [
          {
            id: CODE,
            code: "plaintext-secret",
            max_uses: 2,
            expires_at: null,
            notes: "note",
            created_at: "raw timestamp",
          },
        ],
      }
    if (sql.includes("admin_revoke_invite_code")) return { rows: [{ ok: true }] }
    return { rows: [] }
  })
  const withTransaction = vi.fn(async (work: (client: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient)
  )
  return {
    query,
    withTransaction,
    repository: new AdminInviteRepository({ withTransaction } as unknown as DbService),
  }
}

describe("AdminInviteRepository", () => {
  it.each(["required", "listCodes"] as const)(
    "sets actor claims and authorizes before %s reads",
    async (method) => {
      const { repository, query } = setup()
      await repository[method](ACTOR)
      expect(query.mock.calls[0]).toEqual([
        "SELECT set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: ACTOR, role: "authenticated" })],
      ])
      expect(query.mock.calls[1]).toEqual(["SELECT private.is_admin() AS allowed"])
      expect(query.mock.calls[2]![0]).not.toContain("code_hash")
    }
  )

  it.each(["required", "listCodes"] as const)(
    "performs no protected %s read when database authorization fails",
    async (method) => {
      const { repository, query } = setup()
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ allowed: false }] })
      await expect(repository[method](ACTOR)).rejects.toBeInstanceOf(AdminAccessDeniedError)
      expect(query).toHaveBeenCalledTimes(2)
    }
  )

  it("parameterizes creation and writes non-secret audit metadata", async () => {
    const { repository, query } = setup()
    await repository.createCode(ACTOR, {
      maxUses: 2,
      expiresAt: null,
      notes: "quote '",
    })
    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining("$1::integer, $2::timestamptz, $3::text"),
      [2, null, "quote '"],
    ])
    expect(query.mock.calls[2]![1]).toEqual([
      CODE,
      JSON.stringify({ max_uses: 2, expires_at: null, notes: "quote '" }),
    ])
    expect(query.mock.calls[2]![0]).not.toMatch(/code_hash|\bcode\b/)
    expect(String(query.mock.calls[2]![1])).not.toContain("plaintext-secret")
  })

  it("parameterizes revocation and audits only successful mutations", async () => {
    const successful = setup()
    await successful.repository.revokeCode(ACTOR, CODE)
    expect(successful.query.mock.calls[1]).toEqual([
      "SELECT public.admin_revoke_invite_code($1::uuid) AS ok",
      [CODE],
    ])
    expect(successful.query.mock.calls[2]![1]).toEqual([CODE])

    const missing = setup()
    missing.query.mockImplementation(async (sql: string) =>
      sql.includes("admin_revoke_invite_code") ? { rows: [{ ok: false }] } : { rows: [] }
    )
    await expect(missing.repository.revokeCode(ACTOR, CODE)).resolves.toBe(false)
    expect(missing.query).toHaveBeenCalledTimes(2)
  })

  it.each(["createCode", "revokeCode"] as const)(
    "propagates audit failure from %s so the actor transaction rolls back",
    async (method) => {
      const { repository, query } = setup()
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce(
          method === "createCode"
            ? {
                rows: [
                  {
                    id: CODE,
                    code: "plaintext-secret",
                    max_uses: 1,
                    expires_at: null,
                    notes: null,
                    created_at: "raw timestamp",
                  },
                ],
              }
            : { rows: [{ ok: true }] }
        )
        .mockRejectedValueOnce(new Error("audit failed"))
      const operation =
        method === "createCode"
          ? repository.createCode(ACTOR, { maxUses: 1, expiresAt: null, notes: null })
          : repository.revokeCode(ACTOR, CODE)
      await expect(operation).rejects.toThrow("audit failed")
    }
  )
})
