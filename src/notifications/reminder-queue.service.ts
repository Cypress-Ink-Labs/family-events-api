import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"

import { JobsService } from "../jobs/jobs.service.js"
import { CronGateService } from "../pipeline/cron-gate.service.js"
import { FAMILIES } from "../pipeline/families.js"
import { isFamilyEnabled } from "../pipeline/flags.js"
import { ReminderService } from "./reminder.service.js"

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
          data: { task: "send" },
          key: schedule.key,
        })),
        localConcurrency: family.concurrency,
      }
    )
    this.logger.log("reminders family registered (queue, dlq, schedule; no retries)")
  }

  async handleJob(data: ReminderJobData): Promise<void> {
    if (data.task !== "send") {
      throw new Error(`unknown reminders task: ${String(data.task)}`)
    }
    const schedule = FAMILIES.reminders.schedules[0]
    if (!schedule) throw new Error("reminders family schedule missing")
    await this.gate.runGated(schedule, async () => {
      const summary = await this.reminders.processRun(new Date())
      this.logger.log(
        `reminder run complete: emailed=${summary.emailed} skipped=${summary.skipped}`
      )
      return JSON.stringify(summary)
    })
  }
}
