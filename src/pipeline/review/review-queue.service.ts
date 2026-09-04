import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"

import { JobsService } from "../../jobs/jobs.service.js"
import { CronGateService } from "../cron-gate.service.js"
import {
  FAMILIES,
  isLegacyReplacementSchedule,
  type LegacyReplacementSchedule,
} from "../families.js"
import { isFamilyEnabled } from "../flags.js"
import { errorMessage, logEdgeEvent } from "../logger.js"
import { resolveLlmReviewConfig, type EnvReader } from "./event-review/index.js"
import { processReviewQueueBatch } from "./process-review-queue.js"
import { ReviewRepository } from "./review.repository.js"

type ReviewTask = "process-review-queue"

export interface ReviewJobData {
  task?: unknown
}

/** Review-family pg-boss registration, absent in production until CUTOVER_REVIEW flips. */
@Injectable()
export class ReviewQueueService implements OnModuleInit {
  private readonly logger = new Logger(ReviewQueueService.name)

  constructor(
    private readonly jobs: JobsService,
    private readonly gate: CronGateService,
    private readonly repository: ReviewRepository
  ) {}

  onModuleInit(): void {
    if (!isFamilyEnabled("review", process.env)) {
      this.logger.log("review family disabled by cutover flag; queue not installed")
      return
    }

    const family = FAMILIES.review
    this.jobs.registerQueue(family.deadLetter, null)
    this.jobs.registerQueue<ReviewJobData>(
      family.queue,
      (data) => this.handleJob(data),
      {
        name: family.queue,
        deadLetter: family.deadLetter,
        retryLimit: family.retryLimit,
        retryDelay: family.retryDelay,
        retryBackoff: family.retryBackoff,
      },
      {
        schedules: family.schedules.map((schedule) => ({
          cron: schedule.cron,
          data: { task: schedule.task },
          key: schedule.key,
        })),
        localConcurrency: family.concurrency,
      }
    )
    this.logger.log("review family registered (queue, dlq, schedules)")
  }

  async handleJob(data: ReviewJobData): Promise<void> {
    if (data.task === "process-review-queue") return this.runTask(data.task)
    throw new Error(`unknown review task: ${String(data.task)}`)
  }

  private async runTask(task: ReviewTask): Promise<void> {
    return this.gate.runGated(this.schedule(task), async () => {
      const config = resolveLlmReviewConfig(this.envReader(), await this.loadFeatureConfig())
      const batchSizeValue = process.env["LLM_REVIEW_BATCH_SIZE"]
      const summary = await processReviewQueueBatch(this.repository, {
        config,
        ...(batchSizeValue === undefined ? {} : { batchSize: Number(batchSizeValue) }),
      })
      return JSON.stringify(summary)
    })
  }

  private async loadFeatureConfig() {
    try {
      return await this.repository.loadEventReviewFeatureConfig()
    } catch (error) {
      logEdgeEvent("warn", "event-review feature config lookup failed; using env fallback", {
        function: "process-event-review-queue",
        error: errorMessage(error),
      })
      return null
    }
  }

  private envReader(): EnvReader {
    return { get: (name) => process.env[name] }
  }

  private schedule(key: string): LegacyReplacementSchedule {
    const schedule = FAMILIES.review.schedules.find((candidate) => candidate.key === key)
    if (!schedule || !isLegacyReplacementSchedule(schedule)) {
      throw new Error(`review legacy schedule missing: ${key}`)
    }
    return schedule
  }
}
