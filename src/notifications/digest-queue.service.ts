import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"

import { JobsService } from "../jobs/jobs.service.js"
import { CronGateService } from "../pipeline/cron-gate.service.js"
import { FAMILIES, isLegacyReplacementSchedule } from "../pipeline/families.js"
import { isFamilyEnabled } from "../pipeline/flags.js"
import { DigestService } from "./digest.service.js"
import { SCHEDULED_NOTIFICATION_EXPIRE_SECONDS } from "./scheduled-notification.js"

export interface DigestJobData {
  task?: unknown
  testEmail?: unknown
}

@Injectable()
export class DigestQueueService implements OnModuleInit {
  private readonly logger = new Logger(DigestQueueService.name)

  constructor(
    private readonly jobs: JobsService,
    private readonly gate: CronGateService,
    private readonly digest: DigestService
  ) {}

  onModuleInit(): void {
    if (!isFamilyEnabled("digest", process.env)) {
      this.logger.log("digest family disabled by cutover flag; queue not installed")
      return
    }
    const family = FAMILIES.digest
    this.jobs.registerQueue(family.deadLetter, null)
    this.jobs.registerQueue<DigestJobData>(
      family.queue,
      (data, _jobId, signal) => this.handleJob(data, signal),
      {
        name: family.queue,
        deadLetter: family.deadLetter,
        expireInSeconds: SCHEDULED_NOTIFICATION_EXPIRE_SECONDS,
        retryLimit: 0,
        retryDelay: family.retryDelay,
        retryBackoff: family.retryBackoff,
      },
      {
        schedules: family.schedules.map((schedule) => ({
          cron: schedule.cron,
          data: { task: "send" },
          key: schedule.key,
        })),
        localConcurrency: family.concurrency,
      }
    )
    this.logger.log("digest family registered (queue, dlq, schedule; no retries)")
  }

  async handleJob(data: DigestJobData, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (data.task !== "send" && data.task !== "test") {
      throw new Error(`unknown digest task: ${String(data.task)}`)
    }
    if (data.testEmail !== undefined && typeof data.testEmail !== "string") {
      throw new Error("digest testEmail must be a string")
    }
    const testEmail = typeof data.testEmail === "string" ? data.testEmail : undefined
    if (data.task === "test") {
      if (!testEmail?.trim()) throw new Error("digest test task requires testEmail")
      const summary = await this.digest.processRun(new Date(), testEmail, signal)
      signal?.throwIfAborted()
      this.logger.log(
        `digest test complete: emailed=${summary.emailed} skipped=${summary.skipped} failed=${summary.failed} telegramSent=${summary.telegramSent} telegramFailed=${summary.telegramFailed} telegramSkipped=${summary.telegramSkipped}`
      )
      return
    }
    if (testEmail !== undefined) {
      throw new Error("scheduled digest task does not accept testEmail; use task=test")
    }
    const schedule = FAMILIES.digest.schedules[0]
    if (!schedule || !isLegacyReplacementSchedule(schedule)) {
      throw new Error("digest legacy schedule missing")
    }
    await this.gate.runGated(schedule, async () => {
      signal?.throwIfAborted()
      const summary = await this.digest.processRun(new Date(), undefined, signal)
      signal?.throwIfAborted()
      this.logger.log(
        `digest run complete: emailed=${summary.emailed} skipped=${summary.skipped} failed=${summary.failed} telegramSent=${summary.telegramSent} telegramFailed=${summary.telegramFailed} telegramSkipped=${summary.telegramSkipped}`
      )
      return JSON.stringify(summary)
    })
  }
}
