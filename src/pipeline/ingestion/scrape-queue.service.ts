import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"

import { JobsService } from "../../jobs/jobs.service.js"
import { CronGateService } from "../cron-gate.service.js"
import { FailurePingService } from "../failure-ping.service.js"
import { FAMILIES, type FamilySchedule } from "../families.js"
import { isFamilyEnabled } from "../flags.js"
import { errorMessage, logEdgeEvent } from "../logger.js"
import { IngestionRepository } from "./ingestion.repository.js"
import { extractWithLlm } from "./llm-extraction.js"
import { parsers } from "./parsers/index.js"
import { importParsedSourceEvents } from "./process-source.js"
import {
  processSourceQueueBatch,
  type SourceQueueWorkerDependencies,
} from "./source-queue.worker.js"

const DRAIN_TASK = "drain-source-queue"

type ScrapeTask = "scrape-due-sources" | "cleanup-stale-runs" | typeof DRAIN_TASK

export interface ScrapeJobData {
  task?: unknown
}

/**
 * Scrape family registration (U28, completing the U27 tail): installs the
 * pg-boss queue, its dead-letter queue, and the two U12-parity schedules —
 * hourly scrape-due-sources (replacing cron-scrape-sources) and half-hourly
 * cleanup-stale-runs (replacing cron-cleanup-stale) — behind the
 * CUTOVER_SCRAPE creation-time gate. Until the flag flips in production,
 * nothing here exists at boot and the Railway crons stay the single writer.
 *
 * Drain semantics (documented deviation from the legacy HTTP kicks): the
 * legacy scrape-due-sources edge function fired one fire-and-forget HTTP kick
 * at process-source-queue, which claimed ONE row per invocation. Here the
 * kick is a "drain-source-queue" pg-boss job with the same claim-1 +
 * time-budget semantics that re-sends itself while claimable rows remain, so
 * a burst of due sources drains without waiting for the next hourly tick.
 * Retry rows parked in the future are intentionally NOT chained — they come
 * due later and are picked up by the next scheduled tick, matching legacy
 * cadence.
 */
@Injectable()
export class ScrapeQueueService implements OnModuleInit {
  private readonly logger = new Logger(ScrapeQueueService.name)

  constructor(
    private readonly jobs: JobsService,
    private readonly gate: CronGateService,
    private readonly repository: IngestionRepository,
    private readonly failurePing: FailurePingService
  ) {}

  onModuleInit(): void {
    if (!isFamilyEnabled("scrape", process.env)) {
      this.logger.log("scrape family disabled by cutover flag; queue not installed")
      return
    }

    const family = FAMILIES.scrape
    this.jobs.registerQueue(family.deadLetter, null)
    this.jobs.registerQueue<ScrapeJobData>(
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
    this.logger.log("scrape family registered (queue, dlq, schedules)")
  }

  async handleJob(data: ScrapeJobData): Promise<void> {
    const task = data.task
    if (task === "scrape-due-sources" || task === "cleanup-stale-runs" || task === DRAIN_TASK) {
      return this.runTask(task)
    }
    throw new Error(`unknown scrape task: ${String(task)}`)
  }

  private async runTask(task: ScrapeTask): Promise<void> {
    switch (task) {
      case "scrape-due-sources":
        return this.scrapeDueSources()
      case "cleanup-stale-runs":
        return this.cleanupStaleRuns()
      case "drain-source-queue":
        return this.drainSourceQueue()
      default: {
        const exhaustive: never = task
        throw new Error(`unhandled scrape task: ${String(exhaustive)}`)
      }
    }
  }

  /** Port of the scrape-due-sources edge function body (U28). */
  private async scrapeDueSources(): Promise<void> {
    await this.gate.runGated(this.schedule("scrape-due-sources"), async () => {
      await this.repository.runDueSourceScrapes()
      // The legacy function kicked process-source-queue once after enqueueing
      // (EdgeRuntime.waitUntil); kick failure was a logged warn, never fatal.
      try {
        await this.sendDrainKick()
      } catch (kickError) {
        logEdgeEvent("warn", "source-queue safety kick failed", {
          function: "scrape-due-sources",
          stage: "kick-source",
          error: errorMessage(kickError),
        })
      }
      return "dispatched"
    })
  }

  /** Port of the cleanup-stale-runs edge function body (U28). */
  private async cleanupStaleRuns(): Promise<void> {
    await this.gate.runGated(this.schedule("cleanup-stale-runs"), async () => {
      await this.repository.runCleanupStaleRuns()
      logEdgeEvent("log", "cleanup-stale-runs completed", { function: "cleanup-stale-runs" })
      return "completed"
    })
  }

  private async drainSourceQueue(): Promise<void> {
    const summary = await processSourceQueueBatch(this.repository, this.workerDependencies())
    logEdgeEvent("log", "source-queue batch done", {
      function: "process-source-queue",
      ...summary,
    })
    // Chain the next drain while immediately-claimable work remains. When this
    // invocation claimed nothing (empty queue or budget release), stop — the
    // next scheduled tick resumes.
    if (summary.started > 0 && (await this.repository.hasClaimableSourceScrapeRows())) {
      await this.sendDrainKick()
    }
  }

  private sendDrainKick(): Promise<string | null> {
    // singletonKey: at most one queued drain job at a time — a burst of kicks
    // collapses into one drain chain.
    return this.jobs.send(FAMILIES.scrape.queue, { task: DRAIN_TASK }, { singletonKey: DRAIN_TASK })
  }

  private workerDependencies(): SourceQueueWorkerDependencies {
    return {
      parsers,
      importParsedSourceEvents,
      extractWithLlm,
      notifyFailure: async (notice) => {
        await this.failurePing.send({
          functionName: "process-source-queue",
          kind: notice.kind,
          subject: notice.sourceName,
          error: notice.error,
        })
      },
    }
  }

  private schedule(key: string): FamilySchedule {
    const schedule = FAMILIES.scrape.schedules.find((candidate) => candidate.key === key)
    if (!schedule) throw new Error(`scrape family schedule missing: ${key}`)
    return schedule
  }
}
