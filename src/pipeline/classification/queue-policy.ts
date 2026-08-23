// Tag-queue completion status resolver and time-budget guard.
// Ported from family-events-backend supabase/functions/process-tag-queue/queue-policy.ts (U29).
// Deviations:
// - EventTagQueueStatus came from the legacy monorepo's packages/contracts
//   package, which doesn't exist in this repo. Defines a local TagQueueStatus
//   literal union mirroring the event_tag_queue_status Postgres enum
//   (pending | processing | failed | dead | succeeded) instead.

export type TagQueueStatus = "pending" | "processing" | "failed" | "dead" | "succeeded"

export function resolveCompletedTagQueueStatus(): TagQueueStatus {
  return "succeeded"
}

export function shouldStopBeforeStartingNextTagRow(elapsedMs: number, budgetMs: number): boolean {
  return elapsedMs >= budgetMs - 5_000
}
