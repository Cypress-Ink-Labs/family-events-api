import {
  Injectable,
  Inject,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { PgBoss, type JobResult, type Queue, type SendOptions } from "pg-boss"

import type { Env } from "../config/env.js"
import {
  consoleStructuredLogSink,
  emitStructuredLog,
  runWithLogCorrelation,
  STRUCTURED_LOG_SINK,
  type StructuredLogSink,
} from "../observability/structured-log.js"

/** Dashboard output is deliberately much smaller than the full structured-log stream. */
export const JOB_OUTPUT_MAX_EVENTS = 25
export const JOB_OUTPUT_MAX_BYTES = 32 * 1024
// Reserve space for the output envelope, JSON punctuation, and future additive fields.
const JOB_OUTPUT_LOG_BYTES = 24 * 1024
const MAX_REPORTED_DURATION_MS = 2_147_483_647

export interface JobSuccessOutput {
  outcome: "success"
  duration_ms: number
  log_events: unknown[]
  dropped_events: number
}

export interface JobFailureOutput {
  outcome: "failure"
  duration_ms: number
  log_events: unknown[]
  dropped_events: number
  error_category: "aborted" | "unhandled_worker_error"
}

export type JobOutput = JobSuccessOutput | JobFailureOutput

const SAFE_JOB_EVENTS = new Set([
  "event_review_applied",
  "event_review_dead_lettered",
  "event_review_low_confidence",
  "event_review_malformed_response",
  "event_review_provider_failed",
  "event_review_queue_claimed",
  "event_review_source_auto_rejected",
  "event_review_started",
  "event_review_trace_failed",
  "worker_job_completed",
])
const SAFE_LOG_LEVELS = new Set(["debug", "info", "log", "warn", "error"])
const SAFE_NUMERIC_FIELDS = new Set([
  "approved",
  "attempt_count",
  "attempts",
  "attemptsMarked",
  "backfilled",
  "claimed",
  "coords",
  "coordsSet",
  "count",
  "dead",
  "dropped",
  "duration_ms",
  "durationMs",
  "emailed",
  "errors",
  "failed",
  "generated",
  "images",
  "imagesSet",
  "images_from_pexels",
  "images_from_pixabay",
  "images_from_scraper",
  "images_from_unsplash",
  "index",
  "pending_after",
  "pendingAfter",
  "persistence_failed",
  "processed",
  "reaped",
  "refreshed",
  "rejected",
  "retrying",
  "sent",
  "skipped",
  "started",
  "succeeded",
  "total",
  "tracked",
  "updated",
  "upserted",
])
const SAFE_BOOLEAN_FIELDS = new Set([
  "enabled",
  "moreWork",
  "ok",
  "persistenceFailed",
  "stoppedEarly",
])
const SAFE_CONTAINER_FIELDS = new Set([
  "attribution_backfill",
  "attributionBackfill",
  "email",
  "in_app",
  "parent_tips",
  "parentTips",
  "push",
  "telegram",
  "tracking",
  "unsplash_tracking",
])
function safeErrorName(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined
    const value = Reflect.get(error, "name")
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

function safeErrorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined
    const value = Reflect.get(error, "code")
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

function projectSummaryFields(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  if (depth > 2) return projected
  for (const [key, field] of Object.entries(value).slice(0, 50)) {
    if (SAFE_BOOLEAN_FIELDS.has(key) && typeof field === "boolean") {
      projected[key] = field
    } else if (
      SAFE_NUMERIC_FIELDS.has(key) &&
      typeof field === "number" &&
      Number.isFinite(field)
    ) {
      projected[key] = field
    } else if (
      SAFE_CONTAINER_FIELDS.has(key) &&
      typeof field === "object" &&
      field !== null &&
      !Array.isArray(field)
    ) {
      const nested = projectSummaryFields(field as Record<string, unknown>, depth + 1)
      if (Object.keys(nested).length > 0) projected[key] = nested
    }
  }
  return projected
}

function projectJobLog(
  value: unknown,
  queue: string,
  jobId: string
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const projected: Record<string, unknown> = {
    event:
      typeof source.event === "string" && SAFE_JOB_EVENTS.has(source.event)
        ? source.event
        : typeof source.message === "string" && SAFE_JOB_EVENTS.has(source.message)
          ? source.message
          : "worker_log",
    queue,
    job_id: jobId,
    ...projectSummaryFields(source),
  }
  if (typeof source.level === "string" && SAFE_LOG_LEVELS.has(source.level)) {
    projected.level = source.level
  }
  if (source.outcome === "success" || source.outcome === "failure") {
    projected.outcome = source.outcome
  }
  if (source.error_category === "aborted" || source.error_category === "unhandled_worker_error") {
    projected.error_category = source.error_category
  }
  return projected
}

export type JobHandler<Data extends object> = (
  data: Data,
  jobId: string,
  signal?: AbortSignal
) => Promise<void>

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

interface ScheduleRemovalRegistration {
  queue: string
  key: string
}

/**
 * pg-boss lifecycle owner. Domain modules register queues before application
 * bootstrap; this service starts pg-boss once, creates the queues, attaches
 * workers, and installs both legacy-replacement and internal schedules.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name)
  private readonly registrations: QueueRegistration[] = []
  private readonly scheduleRemovals: ScheduleRemovalRegistration[] = []
  private boss: PgBoss | null = null

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Optional()
    @Inject(STRUCTURED_LOG_SINK)
    private readonly structuredLogSink: StructuredLogSink = consoleStructuredLogSink
  ) {}

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

  registerScheduleRemoval(queue: string, key: string): void {
    if (this.boss !== null) {
      throw new Error(`schedule removal for "${queue}" registered after pg-boss start`)
    }
    this.scheduleRemovals.push({ queue, key })
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
    this.boss = boss
    try {
      for (const removal of this.scheduleRemovals) {
        await boss.unschedule(removal.queue, removal.key)
      }
      for (const registration of this.registrations) {
        await boss.createQueue(registration.name, registration.options)
        // createQueue is intentionally a no-op for an existing queue. Reconcile
        // mutable options as well so a queue previously created by the old
        // worker or an operator cannot retain stale retry/delivery semantics.
        const {
          name: _name,
          policy: _policy,
          partition: _partition,
          ...mutableOptions
        } = registration.options
        if (Object.keys(mutableOptions).length > 0) {
          await boss.updateQueue(registration.name, mutableOptions)
        }
        const { handler } = registration
        if (handler !== null) {
          await boss.work(
            registration.name,
            {
              batchSize: 1,
              localConcurrency: registration.localConcurrency,
              perJobResults: true,
            },
            async ([job]): Promise<JobResult<JobOutput>[]> => {
              if (!job) return []
              const output = await this.runJob(registration.name, job.id, () =>
                handler(job.data as never, job.id, job.signal)
              )
              return [
                {
                  id: job.id,
                  status: output.outcome === "success" ? "completed" : "failed",
                  output,
                },
              ]
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
    } catch (error) {
      this.boss = null
      await boss.stop({ close: true }).catch(() => undefined)
      throw error
    }
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

  private async runJob(
    queue: string,
    jobId: string,
    handler: () => Promise<void>
  ): Promise<JobOutput> {
    const started = performance.now()
    const events: Array<{ value: unknown; bytes: number }> = []
    let collectedBytes = 0
    let droppedEvents = 0
    const sink: StructuredLogSink = {
      write: (line) => {
        try {
          this.structuredLogSink.write(line)
        } catch {
          // Observability must not change request or worker outcomes. The
          // bounded pg-boss copy can still be projected from this line.
        }
        let value: unknown
        try {
          value = projectJobLog(JSON.parse(line), queue, jobId)
        } catch {
          droppedEvents++
          return
        }
        if (value === null) {
          droppedEvents++
          return
        }
        const persistedLine = JSON.stringify(value)
        const bytes = Buffer.byteLength(persistedLine, "utf8")
        const isCompletion =
          typeof value === "object" &&
          value !== null &&
          (value as { event?: unknown }).event === "worker_job_completed"
        if (bytes > JOB_OUTPUT_LOG_BYTES) {
          droppedEvents++
          return
        }
        if (isCompletion) {
          while (
            events.length >= JOB_OUTPUT_MAX_EVENTS ||
            collectedBytes + bytes > JOB_OUTPUT_LOG_BYTES
          ) {
            const removed = events.shift()
            if (!removed) break
            collectedBytes -= removed.bytes
            droppedEvents++
          }
        }
        if (
          events.length >= JOB_OUTPUT_MAX_EVENTS ||
          collectedBytes + bytes > JOB_OUTPUT_LOG_BYTES
        ) {
          droppedEvents++
          return
        }
        events.push({ value, bytes })
        collectedBytes += bytes
      },
    }
    return runWithLogCorrelation({ queue, job_id: jobId, sink }, async () => {
      try {
        await handler()
        const duration = Math.min(
          MAX_REPORTED_DURATION_MS,
          Math.max(0, Math.round((performance.now() - started) * 100) / 100)
        )
        emitStructuredLog({
          event: "worker_job_completed",
          queue,
          job_id: jobId,
          outcome: "success",
          duration_ms: duration,
        })
        return {
          outcome: "success",
          duration_ms: duration,
          log_events: events.map(({ value }) => value),
          dropped_events: droppedEvents,
        }
      } catch (error) {
        const name = safeErrorName(error)
        const code = safeErrorCode(error)
        const duration = Math.min(
          MAX_REPORTED_DURATION_MS,
          Math.max(0, Math.round((performance.now() - started) * 100) / 100)
        )
        const errorCategory = name === "AbortError" ? "aborted" : "unhandled_worker_error"
        emitStructuredLog({
          event: "worker_job_completed",
          queue,
          job_id: jobId,
          outcome: "failure",
          duration_ms: duration,
          error_category: errorCategory,
          ...(code ? { error_code: code } : {}),
        })
        return {
          outcome: "failure",
          duration_ms: duration,
          log_events: events.map(({ value }) => value),
          dropped_events: droppedEvents,
          error_category: errorCategory,
        }
      }
    })
  }
}
