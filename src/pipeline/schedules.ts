/**
 * Pipeline queue topology: the eight Railway cron services from
 * family-events-backend (.railway/railway.ts + config/deploy.config.json),
 * expressed as pg-boss scheduled queues.
 *
 * Retry semantics carried over from the cron runner: reminder and digest jobs
 * never retry on failure (a retry risks duplicate user-facing sends); every
 * other stage retries once.
 *
 * Queues are NOT registered at boot yet. Registration lands with each stage's
 * ported implementation (U27+), keeping the single-writer rule: the Railway
 * crons remain the only writers until a stage is cut over.
 */

export interface PipelineSchedule {
  /** pg-boss queue name; mirrors the legacy cron service label without the `cron-` prefix. */
  queue: string
  /** Legacy Railway service label, for kill-switch and run-history continuity. */
  legacyLabel: string
  /** Legacy edge function this queue's worker replaces. */
  replacesEdgeFunction: string
  cron: string
  /** pg-boss retryLimit: 0 = never retry (user-facing sends), 1 = retry once. */
  retryLimit: 0 | 1
}

export const PIPELINE_SCHEDULES: readonly PipelineSchedule[] = [
  {
    queue: "scrape-sources",
    legacyLabel: "cron-scrape-sources",
    replacesEdgeFunction: "scrape-due-sources",
    cron: "0 * * * *",
    retryLimit: 1,
  },
  {
    queue: "tag-queue",
    legacyLabel: "cron-tag-queue",
    replacesEdgeFunction: "process-tag-queue",
    cron: "*/5 * * * *",
    retryLimit: 1,
  },
  {
    queue: "review-events",
    legacyLabel: "cron-review-events",
    replacesEdgeFunction: "process-event-review-queue",
    cron: "*/5 * * * *",
    retryLimit: 1,
  },
  {
    queue: "enrich-events",
    legacyLabel: "cron-enrich-events",
    replacesEdgeFunction: "backfill-event-enrichment",
    cron: "*/15 * * * *",
    retryLimit: 1,
  },
  {
    queue: "cleanup-stale",
    legacyLabel: "cron-cleanup-stale",
    replacesEdgeFunction: "cleanup-stale-runs",
    cron: "*/30 * * * *",
    retryLimit: 1,
  },
  {
    queue: "db-maintenance",
    legacyLabel: "cron-db-maintenance",
    replacesEdgeFunction: "db-maintenance",
    cron: "15 3 * * *",
    retryLimit: 1,
  },
  {
    queue: "send-reminders",
    legacyLabel: "cron-send-reminders",
    replacesEdgeFunction: "send-reminders",
    cron: "0 11 * * *",
    retryLimit: 0,
  },
  {
    queue: "send-weekly-digest",
    legacyLabel: "cron-weekly-digest",
    replacesEdgeFunction: "send-weekly-digest",
    cron: "0 13 * * 1",
    retryLimit: 0,
  },
]
