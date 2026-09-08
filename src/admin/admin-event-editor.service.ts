import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"

import { isDatabaseAdminDenial } from "./admin-database.js"
import type { AdminUpdateEventInput } from "./admin-event-editor.input.js"
import {
  AdminEventEditorRepository,
  type AdminEventEditorDetail,
} from "./admin-event-editor.repository.js"

const VALIDATION_ERRORS: Record<string, { path: string; message: string }> = {
  ADMIN_EVENT_TITLE_REQUIRED: { path: "patch.title", message: "title is required" },
  ADMIN_EVENT_END_BEFORE_START: {
    path: "patch.end_datetime",
    message: "must be after start_datetime",
  },
  ADMIN_EVENT_INVALID_AGE_RANGE: {
    path: "patch.age_max",
    message: "must be greater than or equal to age_min",
  },
  ADMIN_EVENT_INVALID_PRICE: { path: "patch.price", message: "must be nonnegative" },
  ADMIN_EVENT_INVALID_STATUS: { path: "patch.status", message: "invalid status" },
}

@Injectable()
export class AdminEventEditorService {
  constructor(private readonly repository: AdminEventEditorRepository) {}

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isDatabaseAdminDenial(error)) {
        throw new ForbiddenException("admin access is not provisioned")
      }
      if (typeof error === "object" && error !== null) {
        const failure = error as { code?: unknown; message?: unknown }
        if (
          failure.message === "ADMIN_EVENT_NOT_FOUND" ||
          (failure.code === "P0002" && failure.message !== "ADMIN_EVENT_ADMIN_REQUIRED")
        ) {
          throw new NotFoundException()
        }
        if (typeof failure.message === "string") {
          const issue = VALIDATION_ERRORS[failure.message]
          if (issue !== undefined) {
            throw new BadRequestException({
              statusCode: 400,
              message: "invalid request body",
              error: "Bad Request",
              issues: [issue],
            })
          }
        }
      }
      throw error
    }
  }

  async get(actor: string, eventId: string): Promise<AdminEventEditorDetail> {
    const detail = await this.call(() => this.repository.get(actor, eventId))
    if (detail === null) throw new NotFoundException()
    return detail
  }

  update(
    actor: string,
    eventId: string,
    input: AdminUpdateEventInput
  ): Promise<AdminEventEditorDetail> {
    return this.call(() => this.repository.update(actor, eventId, input))
  }

  unlock(actor: string, eventId: string): Promise<number> {
    return this.call(() => this.repository.unlock(actor, eventId))
  }
}
