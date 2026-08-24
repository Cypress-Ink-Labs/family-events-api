import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"

import { JobsService } from "../../jobs/jobs.service.js"
import { CronGateService } from "../cron-gate.service.js"
import { EnrichmentRepository } from "../enrichment/enrichment.repository.js"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embedEvent } from "../enrichment/embed-event.js"
import {
  runEnrichmentTick,
  type EnrichmentTickDependencies,
} from "../enrichment/process-enrichment-backfill.js"
import { FAMILIES, type FamilySchedule } from "../families.js"
import { isFamilyEnabled } from "../flags.js"
import { postOpenAiEmbedding } from "../llm-openai.js"
import { ClassificationRepository } from "./classification.repository.js"
import { processTagQueueBatch } from "./process-tag-queue.js"
import { processTagEvent, type TagEventDeps } from "./tag-event.js"

const DRAIN_TASK = "drain-tag-queue"
const OPENAI_BASE_URL = "https://api.openai.com/v1"

type TagTask = "process-tag-queue" | "backfill-enrichment" | typeof DRAIN_TASK

export interface TagJobData {
  task?: unknown
}

export function enrichmentDependenciesFromEnv(
  env: Record<string, string | undefined>
): EnrichmentTickDependencies {
  const unsplashAccessKey = env["UNSPLASH_ACCESS_KEY"]
  return {
    providerKeys: {
      pexels: env["PEXELS_API_KEY"],
      pixabay: env["PIXABAY_API_KEY"],
      unsplash: unsplashAccessKey,
    },
    unsplashAccessKey,
    parentTipsEnv: { get: (name) => env[name] },
  }
}

/**
 * Tag-family pg-boss owner. The two parity schedules share one queue:
 * process-tag-queue drains the durable tag table, while backfill-enrichment
 * runs the geocode/image/parent-tips tick. Production installs neither until
 * CUTOVER_TAG is exactly "true".
 */
@Injectable()
export class TagQueueService implements OnModuleInit {
  private readonly logger = new Logger(TagQueueService.name)

  constructor(
    private readonly jobs: JobsService,
    private readonly gate: CronGateService,
    private readonly classification: ClassificationRepository,
    private readonly enrichment: EnrichmentRepository
  ) {}

  onModuleInit(): void {
    if (!isFamilyEnabled("tag", process.env)) {
      this.logger.log("tag family disabled by cutover flag; queue not installed")
      return
    }

    const family = FAMILIES.tag
    this.jobs.registerQueue(family.deadLetter, null)
    this.jobs.registerQueue<TagJobData>(
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
        batchSize: family.concurrency,
      }
    )
    this.logger.log("tag family registered (queue, dlq, schedules)")
  }

  async handleJob(data: TagJobData): Promise<void> {
    const task = data.task
    if (task === "process-tag-queue" || task === "backfill-enrichment" || task === DRAIN_TASK) {
      return this.runTask(task)
    }
    throw new Error(`unknown tag task: ${String(task)}`)
  }

  private async runTask(task: TagTask): Promise<void> {
    switch (task) {
      case "process-tag-queue":
        return this.gate.runGated(this.schedule(task), async () => {
          const summary = await this.drainTagQueue()
          return JSON.stringify(summary)
        })
      case DRAIN_TASK:
        await this.drainTagQueue()
        return
      case "backfill-enrichment":
        return this.gate.runGated(this.schedule(task), async () => {
          const summary = await runEnrichmentTick(
            this.enrichment,
            enrichmentDependenciesFromEnv(process.env)
          )
          return JSON.stringify(summary)
        })
      default: {
        const exhaustive: never = task
        throw new Error(`unhandled tag task: ${String(exhaustive)}`)
      }
    }
  }

  private async drainTagQueue() {
    const summary = await processTagQueueBatch(this.classification, {
      runTagEvent: async (input) => {
        await processTagEvent(
          {
            event_id: input.eventId,
            source_run_id: input.sourceRunId,
            trigger_type: input.triggerType,
            title: input.title,
            description: input.description,
          },
          this.tagEventDependencies()
        )
      },
    })
    if (summary.moreWork) await this.sendDrainKick()
    return summary
  }

  private sendDrainKick(): Promise<string | null> {
    return this.jobs.send(FAMILIES.tag.queue, { task: DRAIN_TASK }, { singletonKey: DRAIN_TASK })
  }

  private tagEventDependencies(): TagEventDeps {
    const env = process.env
    return {
      db: this.classification,
      memoryDb: this.classification,
      getEnv: (name) => env[name],
      embedEvent: async (input) => {
        await embedEvent(
          this.enrichment,
          {
            eventId: input.event_id,
            title: input.title,
            description: input.description ?? null,
          },
          { apiKey: env["OPENAI_API_KEY"] ?? "" }
        )
      },
      generateEmbedding: async (text, apiKey) => ({
        embedding: await postOpenAiEmbedding({
          baseUrl: OPENAI_BASE_URL,
          apiKey,
          model: EMBEDDING_MODEL,
          input: text,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      }),
    }
  }

  private schedule(key: string): FamilySchedule {
    const schedule = FAMILIES.tag.schedules.find((candidate) => candidate.key === key)
    if (!schedule) throw new Error(`tag family schedule missing: ${key}`)
    return schedule
  }
}
