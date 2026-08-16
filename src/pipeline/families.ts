// Queue registry, ported verbatim from family-events-app src/worker/families.ts
// (U12) — the topology the API inherits when it absorbs the worker. One queue
// per job family plus one dead-letter queue per family (U13's alerting and
// KTD10's triage consume the DLQs). Cron schedules replace the Railway cron
// containers' definitions — the mapping from
// family-events-backend/infra/railway-cron-drift/cron-services.json:
//
//   cron-scrape-sources   0 * * * *      -> scrape    key=scrape-due-sources
//   cron-cleanup-stale    */30 * * * *   -> scrape    key=cleanup-stale-runs
//   cron-tag-queue        */5 * * * *    -> tag       key=process-tag-queue
//   cron-enrich-events    */15 * * * *   -> tag       key=backfill-enrichment
//   cron-review-events    */5 * * * *    -> review    key=process-review-queue
//   cron-weekly-digest    0 13 * * 1     -> digest    key=weekly-digest
//   cron-send-reminders   0 11 * * *     -> reminders key=send-reminders
//   cron-db-maintenance   15 3 * * *     -> NOT a job family: database
//     maintenance stays on the old pipeline until U18, then moves to pg_cron
//     or a dedicated maintenance schedule (decided at U18, not here).
//
// The notify family has no cron: it is fed by other jobs (event-driven).

export const JOB_FAMILIES = ["scrape", "tag", "review", "digest", "reminders", "notify"] as const

export type JobFamily = (typeof JOB_FAMILIES)[number]

export interface FamilySchedule {
  /** Unique per queue; pg-boss keys multiple schedules on one queue by this. */
  key: string
  cron: string
  /** Payload discriminator: the family's handler dispatches on data.task. */
  task: string
  /** The Railway cron service this schedule replaces (mapping doc above). */
  replaces: string
}

export interface FamilyConfig {
  queue: string
  deadLetter: string
  /** Max jobs in flight per work() registration (pg-boss batchSize). */
  concurrency: number
  retryLimit: number
  /** Seconds; base for exponential backoff when retryBackoff is true. */
  retryDelay: number
  retryBackoff: boolean
  schedules: FamilySchedule[]
}

export function queueName(family: JobFamily): string {
  return family
}

export function deadLetterName(family: JobFamily): string {
  return `${family}.dlq`
}

const RETRY_DEFAULTS = { retryLimit: 3, retryDelay: 30, retryBackoff: true }

export const FAMILIES: Record<JobFamily, FamilyConfig> = {
  scrape: {
    queue: queueName("scrape"),
    deadLetter: deadLetterName("scrape"),
    concurrency: 2,
    ...RETRY_DEFAULTS,
    schedules: [
      {
        key: "scrape-due-sources",
        cron: "0 * * * *",
        task: "scrape-due-sources",
        replaces: "cron-scrape-sources",
      },
      {
        key: "cleanup-stale-runs",
        cron: "*/30 * * * *",
        task: "cleanup-stale-runs",
        replaces: "cron-cleanup-stale",
      },
    ],
  },
  tag: {
    queue: queueName("tag"),
    deadLetter: deadLetterName("tag"),
    concurrency: 2,
    ...RETRY_DEFAULTS,
    schedules: [
      {
        key: "process-tag-queue",
        cron: "*/5 * * * *",
        task: "process-tag-queue",
        replaces: "cron-tag-queue",
      },
      {
        key: "backfill-enrichment",
        cron: "*/15 * * * *",
        task: "backfill-enrichment",
        replaces: "cron-enrich-events",
      },
    ],
  },
  review: {
    queue: queueName("review"),
    deadLetter: deadLetterName("review"),
    concurrency: 2,
    ...RETRY_DEFAULTS,
    schedules: [
      {
        key: "process-review-queue",
        cron: "*/5 * * * *",
        task: "process-review-queue",
        replaces: "cron-review-events",
      },
    ],
  },
  digest: {
    queue: queueName("digest"),
    deadLetter: deadLetterName("digest"),
    // Highest blast radius (real user email): strictly serial, no overlap.
    concurrency: 1,
    ...RETRY_DEFAULTS,
    schedules: [
      {
        key: "weekly-digest",
        cron: "0 13 * * 1",
        task: "weekly-digest",
        replaces: "cron-weekly-digest",
      },
    ],
  },
  reminders: {
    queue: queueName("reminders"),
    deadLetter: deadLetterName("reminders"),
    concurrency: 1,
    ...RETRY_DEFAULTS,
    schedules: [
      {
        key: "send-reminders",
        cron: "0 11 * * *",
        task: "send-reminders",
        replaces: "cron-send-reminders",
      },
    ],
  },
  notify: {
    queue: queueName("notify"),
    deadLetter: deadLetterName("notify"),
    concurrency: 4,
    ...RETRY_DEFAULTS,
    schedules: [],
  },
}
