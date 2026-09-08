import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"

import type { AdminEventsInput, AdminStatus } from "./admin-review.input.js"
import { isDatabaseAdminDenial } from "./admin-database.js"
import {
  AdminReviewRepository,
  type AdminEventRow,
  type AdminFacetRow,
} from "./admin-review.repository.js"

export interface AdminEventsPage {
  events: AdminEventRow[]
  totalCount: number
  nextCursor: { afterCreatedAt: string; afterId: string } | null
}

export function safeAdminCount(value: string | number): number {
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    throw new Error("invalid admin count")
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("unsafe admin count")
  return count
}

@Injectable()
export class AdminReviewService {
  constructor(private readonly repository: AdminReviewRepository) {}

  private async call<T>(work: () => Promise<T>, missingEvent = false): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const failure = error as { code?: unknown; message?: unknown }
        if (isDatabaseAdminDenial(error)) {
          throw new ForbiddenException("admin access is not provisioned")
        }
        if (missingEvent && failure.code === "P0002") throw new NotFoundException()
      }
      throw error
    }
  }

  listEvents(actor: string, input: AdminEventsInput): Promise<AdminEventsPage> {
    return this.call(async () => {
      const rows = await this.repository.listEvents(actor, {
        ...input,
        limit: Math.min(input.limit + 1, 500),
      })
      const events = rows.slice(0, input.limit)
      const last = events.at(-1)
      let hasMore = rows.length > input.limit
      // The legacy RPC clamps at 500, so a full maximum page needs a separate probe.
      if (input.limit === 500 && events.length === 500 && last !== undefined) {
        const probe = await this.repository.listEvents(actor, {
          ...input,
          afterCreatedAt: last.created_at,
          afterId: last.id,
          limit: 1,
        })
        hasMore = probe.length > 0
      }
      let total = rows[0]?.total_count
      // An empty cursor page carries no count. Ask the same RPC without the cursor.
      if (total === undefined) {
        const probe = await this.repository.listEvents(actor, {
          ...input,
          afterCreatedAt: null,
          afterId: null,
          limit: 1,
        })
        total = probe[0]?.total_count ?? 0
      }
      return {
        events,
        totalCount: safeAdminCount(total),
        nextCursor:
          hasMore && last !== undefined
            ? { afterCreatedAt: last.created_at, afterId: last.id }
            : null,
      }
    })
  }

  facets(
    actor: string,
    keyword: string | null
  ): Promise<(Omit<AdminFacetRow, "count"> & { count: number })[]> {
    return this.call(async () => {
      const rows = await this.repository.facets(actor, keyword)
      return rows.map((row) => ({ ...row, count: safeAdminCount(row.count) }))
    })
  }

  setStatus(
    actor: string,
    id: string,
    status: AdminStatus,
    reason: string | null
  ): Promise<number> {
    return this.call(() => this.repository.setStatus(actor, id, status, reason), true)
  }

  bulkStatus(actor: string, eventIds: string[], status: AdminStatus): Promise<number> {
    return this.call(() => this.repository.bulkStatus(actor, eventIds, status))
  }

  bulkDelete(actor: string, eventIds: string[]): Promise<number> {
    return this.call(() => this.repository.bulkDelete(actor, eventIds))
  }
}
