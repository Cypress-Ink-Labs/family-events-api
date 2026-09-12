# U32 pg-boss Upgrade and Read-only Dashboard Plan

**Prepared:** 2026-09-11  
**Status:** approved for implementation in two code PRs  
**Scope:** upgrade pg-boss, prove its database migration, then add a separate
read-only dashboard service

## Current baseline

- `family-events-api` declares `pg-boss@^12.27.0`; the resolved baseline is
  `12.27.0`.
- The shared `pgboss` schema is version 37.
- pg-boss `12.30.0` and `@pg-boss/dashboard@1.7.0` support the project runtime
  floor of Node `>=24.0.0`. CI and Railway use the Node 24 release line.
- The API and the legacy pipeline share the same pg-boss schema. A schema
  migration affects every process that reads or writes that job store.

U32 does not change a `CUTOVER_*` flag, queue ownership, schedules, worker
concurrency, or job-family behavior. The two code PRs do not run a production
migration and do not deploy either service.

## Delivery boundaries

Use two code PRs. Merge and observe the pg-boss upgrade before starting the
dashboard PR.

1. **U32-A:** pin `pg-boss` to exactly `12.30.0`, add migration tests, and
   document the operator migration runbook.
2. **U32-B:** add a standalone dashboard package/service pinned to exactly
   `@pg-boss/dashboard@1.7.0`, with fail-closed startup checks.

Do not combine the dependency upgrade and dashboard service in one PR. Do not
edit Railway services or variables in either PR. An operator must approve and
perform each staging or production action after reviewing the corresponding
code PR.

Before merging U32-A, an operator must confirm that a merge to `main` cannot
auto-deploy the new package to the production-connected Railway service. Disable
that auto-deploy path or leave the PR unmerged. A normal merge must not bypass
the maintenance window and single-instance migration sequence below.

## Phase 1: pg-boss 12.30.0

### Dependency and runtime changes

1. Replace the range `pg-boss@^12.27.0` with the exact pin
   `pg-boss@12.30.0` and update the lockfile through pnpm.
2. Declare and test the Node floor `>=24.0.0`. Keep CI and deployment runtime
   declarations consistent with that floor in a separate, approved
   infrastructure change if their current selectors cannot guarantee it.
3. Make no queue, schedule, handler, retry, retention, or `CUTOVER_*` change.

Stop before dependency installation or test execution if `node --version`
reports a version below `24.0.0`.

### Schema migration inventory

Test the complete version 37 to version 40 path, not three isolated happy-path
statements.

- **v38, pg-boss 12.28.0:** adds `job_i10` for
  `key_strict_fifo`. A non-partitioned schema creates the index in the migration
  transaction. A partitioned PostgreSQL schema updates `create_queue` and
  enqueues a `CREATE INDEX CONCURRENTLY` BAM command for each applicable
  partition.
- **v39, pg-boss 12.29.0:** adds nullable `version.reindex_on`. This supports
  the reindex scheduler and its bloat-management state.
- **v40, pg-boss 12.30.0:** adds nullable
  `version.monitor_backoff_on` and `queue.monitor_claim_on`, then initializes
  `monitor_claim_on` from `monitor_on`. It replaces the fetch index
  `job_i5` with `job_i11` on `(name, priority DESC, created_on, start_after)`
  for jobs whose state is below `active` and which are not blocked.
  Non-partitioned schemas create `job_i11` before dropping `job_i5` in the
  transaction. Partitioned schemas use ordered BAM commands:
  `CREATE INDEX CONCURRENTLY job_i11` first, then
  `DROP INDEX CONCURRENTLY job_i5`.

The disposable test must show that the monitor seed preserves the existing
`monitor_on` value. Staging must confirm supervision pace and interrupted BAM
recovery under production-shaped load before pg-boss retires the old fetch
index.

### Migration and compatibility tests

Add a real-PostgreSQL integration fixture at schema version 37 using the exact
`12.27.0` package. Seed a queue, job, keyed schedule, and non-null `monitor_on`
value. Upgrade it with the exact `12.30.0` package.

Cover these cases:

1. Start pg-boss `12.30.0` against v37 and assert one forward migration to v40.
2. Assert the v38-v40 columns, replacement indexes, and version row.
3. Assert `queue.monitor_claim_on = queue.monitor_on` for existing rows.
4. Assert the queued job, keyed schedule, and queue settings survive.
5. Start a second `12.30.0` instance and assert that v40 startup is idempotent.
6. Process one pre-upgrade job and one post-restart job.
7. Wait for all three v38/v40 BAM commands to complete. Assert their recorded
   order builds `job_i10`, builds `job_i11`, then retires `job_i5`. Assert the
   resulting index catalog contains `job_i10` and `job_i11`, not `job_i5`.
8. Fail on any BAM error or bounded completion timeout.
9. Call exported `getMigrationPlans("pgboss", 37)` from the pinned package.
   Assert that its SQL advances through v38, v39, and v40 in order and that
   package-generated plans match startup behavior.
10. Inventory repository calls to confirm that none use `getMigrationPlans`
    with the changed `partitionTables` input or the deprecated `priority` and
    `orderByCreatedOn` fetch options.

Staging supplies the production-shaped evidence that a disposable CI schema
cannot: active and retry jobs, all queue policies in use, priority/FIFO ordering,
partition coverage, interrupted BAM repair, monitor/reindex permissions, and
load behavior. Record those results before production approval.

Package-behavior assertions should test stable effects and required statement
ordering. Avoid snapshots of the complete generated SQL.

## Migration runbook

### Preconditions for either environment

The operator records:

```text
node --version
pnpm exec node -p "require('pg-boss/package.json').version"
SELECT version FROM pgboss.version;
SELECT count(*) FROM pgboss.job WHERE state < 'completed';
SELECT state, count(*) FROM pgboss.job GROUP BY state ORDER BY state;
SELECT version, status, count(*) FROM pgboss.bam GROUP BY version, status ORDER BY version, status;
```

Before startup, confirm:

- Node is `>=24.0.0`;
- the schema reports v37;
- the migration role can alter `pgboss.version` and `pgboss.queue`, replace
  pg-boss functions, and create and drop the required indexes;
- the role owns the indexes or an identified owner will execute reindex work;
- no long transaction or conflicting DDL lock touches the `pgboss` schema;
- queue depth and oldest-job age fall within the environment's normal range;
- current v37 API and worker processes remain available for rollback;
- database backup and point-in-time recovery status meet the production policy.

Stop if any check fails. Do not grant broader production permissions from a
code PR.

### Staging

1. Use a production-shaped staging database with a restored or sanitized v37
   pg-boss schema. An empty newly constructed schema does not qualify.
2. Pause deploy automation. Record the pre-migration queries above, lock
   activity from `pg_stat_activity` and `pg_locks`, queue depth, oldest-job age,
   failed-job count, worker throughput, and API error rate.
3. Start one `12.30.0` API instance. Do not start a mixed fleet.
4. Watch application logs, pg-boss `error`, `warning`, and `bam` events, the
   version row, BAM entries, `pg_stat_progress_create_index`, invalid indexes,
   lock waits, database CPU/IO, queue latency, and job completion/failure rates.
5. Wait for schema v40 and all required BAM work to complete. Confirm `job_i11`
   exists on every applicable job table or partition and `job_i5` retirement
   matches the v40 plan.
6. Run the post-migration integration smoke: enqueue one disposable job for a
   test queue, fetch it, complete it, confirm schedule reads, and compare queue
   ordering and backlog drain with the baseline.
7. Restart the instance once and confirm v40 startup performs no migration.
8. Observe for one full longest active schedule interval, with a minimum
   observation period set in the deployment change record. Capture evidence
   before approving production.

Unavailable or non-production-shaped staging is a stop condition. Do not use
production as the first migration test.

### Production

Production migration and deployment require a separate approved operations
change after U32-A review and staging passes. Do not merge U32-A while a
production-connected `main` branch can auto-deploy it.

1. Before merging U32-A, disable or verify the absence of production auto-deploy
   from `main`. Announce the maintenance window and freeze concurrent deploys.
2. Repeat every precondition query against production and compare backlog,
   oldest-job age, locks, and database load with the accepted staging bounds.
3. Stop the v37 application processes without changing `CUTOVER_*` values or
   enabling a legacy writer. Allow in-flight jobs to reach the agreed drain
   boundary.
4. Start one `12.30.0` instance and observe the same migration, BAM, index,
   lock, database, queue, and error signals used in staging.
5. Add `12.30.0` instances only after schema v40, required BAM commands, and
   the smoke checks pass.
6. Observe for the approved window before closing the maintenance change.

### Failure and rollback policy

Stop rollout on a migration error, permission denial, unexpected schema plan,
blocked DDL, sustained lock wait, invalid index without active BAM repair,
missing fetch index, growing backlog, ordering regression, worker error spike,
or monitor/reindex failure.

Before the version row reaches v40, keep application processes stopped and
diagnose the database state. Do not rerun migration SQL by hand or mark BAM rows
complete. Restore the database to the pre-migration recovery point if the
package cannot resume safely.

After v40 commits, do not point `12.27.0` processes at the v40 schema and do not
attempt a package downgrade as an application-only rollback. Either fix
forward on `12.30.0` or restore the database and application together to the
pre-migration point. An operator must approve either action. Preserve logs,
catalog output, BAM rows, lock evidence, and queue metrics for diagnosis.

> [!IMPORTANT]
> The code PR ends after tests and review. It must not migrate staging or
> production, deploy `12.30.0`, change Railway, or cross a `CUTOVER_*` boundary.

## Phase 2: standalone dashboard 1.7.0

Start U32-B only after phase 1 has passed staging observation and production
approval has no open migration incident.

### Service shape

- Pin `@pg-boss/dashboard@1.7.0` exactly.
- Run the package CLI as its own process:

  ```text
  pnpm exec pg-boss-dashboard
  ```

- Give the process its own package boundary, start command, environment
  validation entrypoint, tests, and deployment definition proposal.
- Do not import or mount the dashboard in Nest. Do not share the API process,
  port, routing, middleware, session state, or failure domain.
- Require the package's built-in Basic Auth. A proxy login alone does not meet
  this requirement.
- Require `PGBOSS_DASHBOARD_READ_ONLY=1`.
- Do not add, assume, or probe an undocumented health route. Configure process
  health through TCP/startup status or a dashboard route the pinned package
  documents. If Railway requires an HTTP health route and the package documents
  none, stop and request an explicit design change instead of inventing one.

### Environment and command contract

The dashboard process accepts these names; documentation and examples contain
no secret values:

```text
DATABASE_URL=<secret database connection URL>
PGBOSS_SCHEMA=pgboss
PGBOSS_DASHBOARD_AUTH_USERNAME=<secret username>
PGBOSS_DASHBOARD_AUTH_PASSWORD=<secret password>
PGBOSS_DASHBOARD_READ_ONLY=1
HOST=0.0.0.0
PORT=<platform-assigned port>
```

The validation entrypoint must reject startup unless:

- `DATABASE_URL` is present and parses as a PostgreSQL URL;
- `PGBOSS_SCHEMA` is present and equals the approved schema name;
- both Basic Auth values are present and non-empty;
- username and password are distinct after validation;
- `PGBOSS_DASHBOARD_READ_ONLY` equals the exact string `"1"`;
- `PORT` is a valid TCP port and `HOST` is present;
- Node is `>=24.0.0`.

The validator must not log credentials or the database URL. It should print one
actionable error naming the invalid variable, then exit nonzero before importing
or starting the dashboard package. Do not add secret values to `.env.example`,
tests, fixtures, command examples, or deployment files.

Use a database role limited to the reads that dashboard `1.7.0` performs. Verify
the role against the pinned package. Do not infer safety from
`PGBOSS_DASHBOARD_READ_ONLY=1`; retain both the package guard and database
least privilege.

### Dashboard tests

Unit tests:

- reject every missing, empty, malformed, or wrong-value required variable;
- reject Node below `24.0.0`;
- accept the documented contract;
- redact secrets and the database URL from errors and logs;
- prove validation runs before dashboard import/start.

Integration tests against disposable PostgreSQL:

- unauthenticated and invalid Basic Auth requests receive `401` and a Basic
  challenge;
- valid Basic Auth can load queue, job, schedule, and dashboard views;
- the configured schema is `pgboss`, with no fallback to the package default;
- every mutation exposed by the UI or server is denied in read-only mode;
- direct mutation requests fail as well as hidden or disabled UI controls;
- read requests do not mutate jobs, queues, schedules, BAM rows, or the schema;
- loss of database access fails without exposing connection details.

Package-behavior tests must run the exact `1.7.0` tarball or installed package,
invoke its CLI through the validation entrypoint, and assert built-in Basic Auth
and `PGBOSS_DASHBOARD_READ_ONLY=1` behavior. Keep these tests independent of
Nest.

### Verification commands

U32-A records clean output from:

```text
node --version
pnpm install --frozen-lockfile
pnpm exec node -p "require('pg-boss/package.json').version"
pnpm check
pnpm test:integration
pnpm build
pnpm openapi
git diff --exit-code -- openapi.json
git diff --check
```

The version command must print `12.30.0`. Use the repository's disposable
PostgreSQL integration harness for `pnpm test:integration`; never point it at
the shared Supabase port or staging.

U32-B adds workspace/package-specific scripts for its validator, unit tests,
integration tests, and build. Record clean output from:

```text
node --version
pnpm install --frozen-lockfile
pnpm exec pg-boss-dashboard --version
pnpm --filter <dashboard-package-name> test
pnpm --filter <dashboard-package-name> test:integration
pnpm --filter <dashboard-package-name> build
pnpm check
pnpm test:integration
pnpm build
git diff --check
```

If the pinned CLI has no `--version` contract, replace that one check with:

```text
pnpm exec node -p "require('@pg-boss/dashboard/package.json').version"
```

It must print `1.7.0`. The implementation PR must replace
`<dashboard-package-name>` with the committed package name and commands; no
placeholder may remain in its verification record.

## Stop conditions

Stop implementation or rollout and request a decision when any of these
conditions applies:

- local, CI, staging, or production Node is below `24.0.0`;
- the database role lacks migration, index ownership, BAM, monitor, or reindex
  permissions required by the tested path;
- backlog, oldest-job age, database load, or lock waits exceed the accepted
  staging bounds;
- staging is unavailable, empty, or does not represent the production v37
  schema and workload shape;
- Basic Auth does not challenge every unauthenticated request;
- read-only mode is absent, has a value other than exact `"1"`, or permits any
  mutation;
- the dashboard needs an undocumented health route or Nest embedding;
- implementation requires a Railway service, variable, domain, health check,
  or other external Railway change that has not received separate approval;
- any task asks the code PR to alter a `CUTOVER_*` value or perform a staging or
  production migration/deployment.

Record the failed check and evidence. Do not weaken validation, broaden
database grants, edit generated migration state, or cross the no-deploy
boundary to make the check pass.
