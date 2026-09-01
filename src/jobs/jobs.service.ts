import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { PgBoss, type Queue, type SendOptions } from "pg-boss"

import type { Env } from "../config/env.js"

export type JobHandler<Data extends object> = (data: Data, jobId: string) => Promise<void>

export interface QueueSchedule {
  cron: string
  data?: object
  /** Distinguishes multiple schedules on one queue (pg-boss schedule key). */
  key?: string
}

interface QueueRegistration {
  name: string
  options: Queue
  schedules: QueueSchedule[]
  /** null = queue only (e.g. a dead-letter queue nothing consumes yet). */
  handler: JobHandler<never> | null
  /** Independent single-job workers to spawn for this queue in this process. */
  localConcurrency: number
}

/**
 * pg-boss lifecycle owner. Domain modules register queues before application
 * bootstrap; this service starts pg-boss once, creates the queues, attaches
 * workers, and installs cron schedules (replacing the Railway cron runner).
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name)
  private readonly registrations: QueueRegistration[] = []
  private boss: PgBoss | null = null

  constructor(private readonly config: ConfigService<Env, true>) {}

  registerQueue<Data extends object>(
    name: string,
    handler: JobHandler<Data> | null,
    options: Queue = { name },
    config: { schedules?: QueueSchedule[]; localConcurrency?: number } = {}
  ): void {
    if (this.boss !== null) {
      throw new Error(`queue "${name}" registered after pg-boss start`)
    }
    this.registrations.push({
      name,
      options,
      schedules: config.schedules ?? [],
      handler: handler as JobHandler<never> | null,
      localConcurrency: config.localConcurrency ?? 1,
    })
  }

  async send(name: string, data: object, options?: SendOptions): Promise<string | null> {
    return this.requireBoss().send(name, data, options ?? {})
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get("NODE_ENV", { infer: true }) === "test") {
      return // unit tests never touch a live pg-boss instance
    }
    const boss = new PgBoss({
      connectionString: this.config.get("DATABASE_URL", { infer: true }),
      schema: this.config.get("PGBOSS_SCHEMA", { infer: true }),
    })
    boss.on("error", (error) => this.logger.error(`pg-boss error: ${error.message}`))
    await boss.start()
    for (const registration of this.registrations) {
      await boss.createQueue(registration.name, registration.options)
      const { handler } = registration
      if (handler !== null) {
        await boss.work(
          registration.name,
          { batchSize: 1, localConcurrency: registration.localConcurrency },
          async ([job]) => {
            if (job) await handler(job.data as never, job.id)
          }
        )
      }
      for (const schedule of registration.schedules) {
        await boss.schedule(
          registration.name,
          schedule.cron,
          schedule.data ?? {},
          schedule.key === undefined ? {} : { key: schedule.key }
        )
      }
    }
    this.boss = boss
    this.logger.log(`pg-boss started with ${this.registrations.length} queue(s)`)
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.boss !== null) {
      await this.boss.stop({ close: true })
      this.boss = null
    }
  }

  private requireBoss(): PgBoss {
    if (this.boss === null) {
      throw new Error("pg-boss is not started")
    }
    return this.boss
  }
}
