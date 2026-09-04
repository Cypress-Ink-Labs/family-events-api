import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { MAX_PUSH_USER_IDS, PushRepository } from "./push.repository.js"

describe("PushRepository", () => {
  it("deduplicates user IDs and uses one parameterized subscription query", async () => {
    const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [])
    const repository = new PushRepository({ query } as unknown as DbService)

    await expect(repository.listSubscriptions(["user-1", "user-1", "user-2"])).resolves.toEqual([])

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("user_id = ANY($1::uuid[])")
    expect(sql).not.toContain("user-1")
    expect(params).toEqual([["user-1", "user-2"]])
  })

  it("rejects an unbounded recipient list before querying", async () => {
    const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [])
    const repository = new PushRepository({ query } as unknown as DbService)
    const userIds = Array.from({ length: MAX_PUSH_USER_IDS + 1 }, (_, index) => `user-${index}`)

    await expect(repository.listSubscriptions(userIds)).rejects.toThrow(/recipient limit/)
    expect(query).not.toHaveBeenCalled()
  })

  it("deletes deduplicated expired subscription IDs with a parameter", async () => {
    const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [])
    const repository = new PushRepository({ query } as unknown as DbService)

    await repository.deleteExpiredSubscriptions(["sub-1", "sub-1", "sub-2"])

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("id = ANY($1::uuid[])")
    expect(sql).not.toContain("sub-1")
    expect(params).toEqual([["sub-1", "sub-2"]])
  })

  it("returns no vault credentials when the optional vault lookup fails", async () => {
    const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => {
      throw new Error("vault is unavailable")
    })
    const repository = new PushRepository({ query } as unknown as DbService)

    await expect(repository.loadCredentials()).resolves.toEqual({})
  })

  it("loads only the named non-empty vault credentials with a parameterized query", async () => {
    const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [
      { name: "vapid_public_key", decryptedSecret: "vault-public" },
      { name: "apns_team_id", decryptedSecret: "" },
      { name: "unrelated_secret", decryptedSecret: "ignore-me" },
    ])
    const repository = new PushRepository({ query } as unknown as DbService)

    await expect(repository.loadCredentials()).resolves.toEqual({
      vapid_public_key: "vault-public",
    })
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("name = ANY($1::text[])")
    expect(sql).not.toContain("vapid_public_key")
    expect(params?.[0]).toContain("vapid_public_key")
  })
})
