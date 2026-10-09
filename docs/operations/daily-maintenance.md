# Daily database maintenance

The dedicated `maintenance` queue runs `public.run_daily_maintenance()` at
`15 3 * * *` UTC. The function remains in the frozen bootstrap. No SQL function,
retention rule, API migration, or existing data changes for this runtime port.

The retained operation prunes dead tag rows older than 30 days, failed tag rows
older than 7 days, invite request/redemption attempts older than 30 days, and
recommendation signals plus AI/extraction traces older than 90 days. It also
refreshes the timezone cache. Database work is transactional, and a PostgreSQL
advisory lock prevents concurrent maintenance across API processes.

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
historical records remain available; no table or user data is dropped.

Repeated runtime boot upserts the same queue/key schedule rather than creating
another daily schedule. Local tests use disposable PostgreSQL, frozen function
fixtures, and real pg-boss registration without network providers or delivery.
