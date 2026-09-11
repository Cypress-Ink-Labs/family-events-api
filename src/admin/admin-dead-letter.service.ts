import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"

import { isDatabaseAdminDenial } from "./admin-database.js"
import { AdminDeadLetterRepository, type DeadLetterRow } from "./admin-dead-letter.repository.js"
import {
  encodeDeadLetterCursor,
  type DeadLetterListInput,
  type DeadLetterQueue,
} from "./admin-dead-letter.input.js"

@Injectable()
export class AdminDeadLetterService {
  constructor(private readonly repository: AdminDeadLetterRepository) {}

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isDatabaseAdminDenial(error)) {
        throw new ForbiddenException("admin access is not provisioned")
      }
      throw error
    }
  }

  async list(
    actor: string,
    input: DeadLetterListInput
  ): Promise<{
    items: (DeadLetterRow & { queue: DeadLetterQueue })[]
    nextCursor: string | null
  }> {
    const rows = await this.call(() => this.repository.list(actor, input))
    const hasMore = rows.length > input.limit
    const items = rows.slice(0, input.limit).map((row) => ({ ...row, queue: input.queue }))
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeDeadLetterCursor({ finishedAt: last.finished_at, id: last.id })
          : null,
    }
  }

  async retry(actor: string, queue: DeadLetterQueue, id: string) {
    const result = await this.call(() => this.repository.retry(actor, queue, id))
    if (result === null) throw new NotFoundException()
    return result
  }

  async remove(actor: string, queue: DeadLetterQueue, id: string): Promise<void> {
    if (!(await this.call(() => this.repository.remove(actor, queue, id)))) {
      throw new NotFoundException()
    }
  }
}
