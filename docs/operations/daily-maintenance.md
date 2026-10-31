# Daily database maintenance

The dedicated `maintenance` queue runs `public.run_daily_maintenance()` at
`15 3 * * *` UTC. The function remains in the frozen bootstrap. Migration
`20261030001000` adds `private.run_retention(integer)`, which the API calls after
the legacy function has committed (see Retention below).

The retained operation prunes dead tag rows older than 30 days, failed tag rows
older than 7 days, invite request/redemption attempts older than 30 days, and
recommendation signals and AI/extraction traces older than 90
days (the retention step below shortens those windows). It also
refreshes the timezone cache. Database work is transactional, and a PostgreSQL
advisory lock prevents concurrent maintenance across API processes.

## Retention

After the legacy function commits, the service calls `private.run_retention(5000)`
repeatedly, one transaction per call, until no table deletes a full batch (at most
200 calls; a run that stops early logs a warning and finishes on the next run).
Each call deletes at most 5000 rows per table:

| Table | Deleted when |
|---|---|
| `public.event_ai_traces` | `created_at` older than 14 days |
| `public.event_llm_review_traces` | `created_at` older than 14 days, or its queue row is deleted |
| `public.event_llm_review_queue` | `succeeded` and `finished_at` older than 14 days |
| `public.event_tag_queue` | `succeeded` and `finished_at` older than 14 days (`dead`/`failed` keep the legacy rules) |
| `public.source_extraction_traces` | `created_at` older than 30 days |
| `private.cron_run_log_entries` | `created_at` older than 30 days |
| `private.railway_cron_runs` | `ran_at` older than 30 days |

Pending, processing, retrying and dead rows are never deleted by this step. The
run summary gains a `retention` object with rows deleted per table, `passes`,
`drained` and `database_size_bytes`; the service logs a warning when the size is
above 400 MB. Until the migration is applied the step reports
`skipped: not installed` and the legacy work runs unchanged. The paired rollback
drops the function; deleted rows are not recoverable. Deletion frees space for
reuse inside the database but does not shrink files already allocated.

## Gates

Production installs the queue and schedule only when `CUTOVER_MAINTENANCE` is
exactly `true`. The database role must retain permission to call the existing
maintenance function. Missing `cron-db-maintenance` ownership means legacy
enabled. API execution requires that legacy bit to be false and
`nestjs:cron-db-maintenance` to be true. A missing API operational bit means true.

The operator Scheduled operations page shows both gates, UTC timing, completed
history, and manual queue receipts. Queue acceptance is not completed work.
Run summaries reuse the historical `cron-db-maintenance` label and have no HTTP
status because execution runs inside the API.

Before a production handoff, stop and drain active legacy maintenance runs.
That verification remains external to this local implementation. For rollback,
pause API ownership, let active jobs finish, and return the owner to legacy.
The owner operation rejects rollback while API jobs in the family are active.
Redeploying with the cutover flag false removes the API schedule. Queues and
historical records remain available; rollback drops no table.

Repeated runtime boot upserts the same queue/key schedule rather than creating
another daily schedule. Local tests use disposable PostgreSQL, frozen function
fixtures, and real pg-boss registration without network providers or delivery.
