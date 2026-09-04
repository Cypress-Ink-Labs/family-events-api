import { Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common"

import { JobsService } from "../jobs/jobs.service.js"
import { FAMILIES } from "../pipeline/families.js"
import { isFamilyEnabled } from "../pipeline/flags.js"
import { NotificationQueueService } from "./notification-queue.service.js"

export interface NotifyJobData {
  task?: unknown
}

@Injectable()
export class NotifyQueueService implements OnModuleInit {
  private readonly logger = new Logger(NotifyQueueService.name)

  constructor(
    private readonly jobs: JobsService,
    private readonly notifications: NotificationQueueService,
    @Optional() private readonly env?: Record<string, string | undefined>
  ) {}

  onModuleInit(): void {
    if (!isFamilyEnabled("notify", this.env ?? process.env)) {
      this.logger.log("notify family disabled by cutover flag; queue not installed")
      return
    }
    const family = FAMILIES.notify
    this.jobs.registerQueue(family.deadLetter, null)
    this.jobs.registerQueue<NotifyJobData>(
      family.queue,
      (data) => this.handleJob(data),
      {
        name: family.queue,
        deadLetter: family.deadLetter,
        retryLimit: 0,
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
    this.logger.log("notify family registered: queues=2 schedules=1 retry_limit=0 concurrency=1")
  }

  async handleJob(data: NotifyJobData): Promise<void> {
    if (data.task !== "process") throw new Error("unknown notify task")
    const result = await this.notifications.processRun(new Date())
    const counts = result.channels
    const message =
      `notify run complete: ok=${result.ok} processed=${result.processed} ` +
      `persistence_failed=${result.persistenceFailed} ` +
      `email_sent=${counts.email.sent} email_failed=${counts.email.failed} ` +
      `email_skipped=${counts.email.skipped} in_app_sent=${counts.inApp.sent} ` +
      `in_app_failed=${counts.inApp.failed} in_app_skipped=${counts.inApp.skipped} ` +
      `push_sent=${counts.push.sent} push_failed=${counts.push.failed} ` +
      `push_skipped=${counts.push.skipped} push_pruned=${counts.push.pruned}`
    if (result.ok) this.logger.log(message)
    else this.logger.error(message)
  }
}
