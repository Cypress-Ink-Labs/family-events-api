import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"

import { JobsService } from "../jobs/jobs.service.js"
import { isFamilyEnabled } from "../pipeline/flags.js"
import { sendSourceQueueDrain } from "../pipeline/ingestion/scrape-queue.service.js"
import { isDatabaseAdminDenial } from "./admin-database.js"
import type {
  AdminCreateSourceInput,
  AdminProcessingMode,
  AdminSourcePatch,
} from "./admin-source.input.js"
import {
  AdminSourceRepository,
  InactiveAdminSourceError,
  type AdminSourceRow,
  type AdminSourceScrapeResult,
} from "./admin-source.repository.js"

const SOURCE_VALIDATION_ERRORS: Record<string, { path: string; message: string }> = {
  ADMIN_SOURCE_NAME_REQUIRED: { path: "name", message: "name is required" },
  ADMIN_SOURCE_URL_REQUIRED: { path: "url", message: "url is required" },
}

@Injectable()
export class AdminSourceService {
  private readonly logger = new Logger(AdminSourceService.name)

  constructor(
    private readonly repository: AdminSourceRepository,
    private readonly jobs: JobsService
  ) {}

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isDatabaseAdminDenial(error)) {
        throw new ForbiddenException("admin access is not provisioned")
      }
      if (error instanceof InactiveAdminSourceError) {
        throw new BadRequestException({
          statusCode: 400,
          message: "invalid request body",
          error: "Bad Request",
          issues: [{ path: "id", message: "source is inactive" }],
        })
      }
      if (typeof error === "object" && error !== null) {
        const failure = error as { code?: unknown; message?: unknown }
        if (
          failure.message === "ADMIN_SOURCE_NOT_FOUND" ||
          (failure.code === "P0002" &&
            typeof failure.message === "string" &&
            failure.message.startsWith("source not found:"))
        ) {
          throw new NotFoundException()
        }
        if (typeof failure.message === "string") {
          const issue = SOURCE_VALIDATION_ERRORS[failure.message]
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

  list(actor: string): Promise<AdminSourceRow[]> {
    return this.call(() => this.repository.list(actor))
  }

  create(actor: string, input: AdminCreateSourceInput): Promise<AdminSourceRow> {
    return this.call(() => this.repository.create(actor, input))
  }

  update(actor: string, sourceId: string, patch: AdminSourcePatch): Promise<AdminSourceRow> {
    return this.call(() => this.repository.update(actor, sourceId, patch))
  }

  setProcessingMode(
    actor: string,
    sourceId: string,
    mode: AdminProcessingMode
  ): Promise<AdminSourceRow> {
    return this.call(() => this.repository.setProcessingMode(actor, sourceId, mode))
  }

  async bulkSetProcessingMode(actor: string, mode: AdminProcessingMode): Promise<void> {
    await this.call(() => this.repository.bulkSetProcessingMode(actor, mode))
  }

  async scrape(actor: string, sourceId: string): Promise<AdminSourceScrapeResult> {
    const result = await this.call(() => this.repository.scrape(actor, sourceId))
    if (result === null) throw new NotFoundException()
    if (isFamilyEnabled("scrape", process.env)) {
      try {
        await sendSourceQueueDrain(this.jobs)
      } catch (error) {
        this.logger.warn(
          `source queue drain kick failed after durable enqueue: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
    return result
  }
}
