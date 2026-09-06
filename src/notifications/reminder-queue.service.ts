import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"

import { JobsService } from "../jobs/jobs.service.js"
import { CronGateService } from "../pipeline/cron-gate.service.js"
import { FAMILIES, isLegacyReplacementSchedule } from "../pipeline/families.js"
import { isFamilyEnabled } from "../pipeline/flags.js"
import { ReminderService } from "./reminder.service.js"
import { SCHEDULED_NOTIFICATION_EXPIRE_SECONDS } from "./scheduled-notification.js"

export interface ReminderJobData {
  task?: unknown
}

@Injectable()
export class ReminderQueueService implements OnModuleInit {
  private readonly logger = new Logger(ReminderQueueService.name)

  constructor(
    private readonly jobs: JobsService,
    private readonly gate: CronGateService,
    private readonly reminders: ReminderService
  ) {}

  onModuleInit(): void {
    if (!isFamilyEnabled("reminders", process.env)) {
      this.logger.log("reminders family disabled by cutover flag; queue not installed")
      return
    }
    const family = FAMILIES.reminders
    this.jobs.registerQueue(family.deadLetter, null)
    this.jobs.registerQueue<ReminderJobData>(
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
    this.logger.log("reminders family registered (queue, dlq, schedule; no retries)")
  }

  async handleJob(data: ReminderJobData, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (data.task !== "send") {
      throw new Error(`unknown reminders task: ${String(data.task)}`)
    }
    const schedule = FAMILIES.reminders.schedules[0]
    if (!schedule || !isLegacyReplacementSchedule(schedule)) {
      throw new Error("reminders legacy schedule missing")
    }
    await this.gate.runGated(schedule, async () => {
      signal?.throwIfAborted()
      const summary = await this.reminders.processRun(new Date(), signal)
      signal?.throwIfAborted()
      this.logger.log(
        `reminder run complete: total=${summary.total} ` +
          Object.entries(summary.channels)
            .map(([channel, counts]) =>
              Object.entries(counts)
                .map(([name, count]) => `${channel}_${name}=${count}`)
                .join(" ")
            )
            .join(" ")
      )
      return JSON.stringify(summary)
    })
  }
}
