import { ForbiddenException, Injectable } from "@nestjs/common"
import { z } from "zod"

import { isDatabaseAdminDenial } from "./admin-database.js"
import type { AdminDashboardStatsDto, AdminPipelineStatsDto } from "./admin-statistics.dto.js"
import { AdminStatisticsRepository } from "./admin-statistics.repository.js"

const safeCount = z.union([z.number(), z.string()]).transform((value, context) => {
  if (typeof value === "string" && !/^(0|[1-9]\d*)$/.test(value)) {
    context.addIssue({ code: "custom", message: "expected a non-negative integer" })
    return z.NEVER
  }
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    context.addIssue({ code: "custom", message: "integer exceeds JavaScript safe range" })
    return z.NEVER
  }
  return number
})

const nullableTimestamp = z.string().nullable()
const dashboardSchema = z.strictObject({
  total_events: safeCount,
  draft_events: safeCount,
  published_events: safeCount,
  ai_confidence: z.strictObject({ high: safeCount, medium: safeCount, low: safeCount }),
  sources: z.strictObject({ active: safeCount, errors: safeCount }),
  dead_letters: z.strictObject({
    tag_queue: safeCount,
    source_queue: safeCount,
    oldest_tag_dead_at: nullableTimestamp,
    oldest_source_dead_at: nullableTimestamp,
  }),
  generated_at: z.string(),
})

const pipelineSchema = z.strictObject({
  window_days: safeCount.pipe(z.number().min(1).max(365)),
  total_reviewed: safeCount,
  llm_reviewed: safeCount,
  admin_reviewed: safeCount,
  auto_rejected: safeCount,
  memory_hits: safeCount,
  total_embeddings: safeCount,
  tag_memory_hits: safeCount,
  top_rejection_sources: z
    .array(
      z.strictObject({
        source_id: z.uuid(),
        source_name: z.string().nullable(),
        total: safeCount,
        rejected: safeCount,
        rejection_rate: z.number().finite().min(0).max(100),
      })
    )
    .max(10),
  feature_flags: z.record(z.string(), z.boolean()),
})

export function parseDashboardStats(value: unknown): AdminDashboardStatsDto {
  return dashboardSchema.parse(value)
}

export function parsePipelineStats(value: unknown): AdminPipelineStatsDto {
  return pipelineSchema.parse(value)
}

@Injectable()
export class AdminStatisticsService {
  constructor(private readonly repository: AdminStatisticsRepository) {}

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

  async dashboard(actor: string): Promise<AdminDashboardStatsDto> {
    return parseDashboardStats(await this.call(() => this.repository.dashboard(actor)))
  }

  async pipeline(actor: string, windowDays: number): Promise<AdminPipelineStatsDto> {
    return parsePipelineStats(await this.call(() => this.repository.pipeline(actor, windowDays)))
  }
}
