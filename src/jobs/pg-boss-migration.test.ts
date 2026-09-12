import { getMigrationPlans } from "pg-boss"
import { describe, expect, it } from "vitest"

describe("pg-boss 12.30 migration plan", () => {
  it("builds replacement indexes before retiring the old fetch index", () => {
    const plan = getMigrationPlans("pgboss_upgrade_test", 37)
    const strictFifoIndex = plan.indexOf("CREATE INDEX CONCURRENTLY IF NOT EXISTS job_common_i10")
    const priorityFetchIndex = plan.indexOf(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS job_common_i11"
    )
    const retiredFetchIndex = plan.indexOf(
      "DROP INDEX CONCURRENTLY IF EXISTS pgboss_upgrade_test.job_common_i5"
    )

    expect(strictFifoIndex).toBeGreaterThan(-1)
    expect(priorityFetchIndex).toBeGreaterThan(strictFifoIndex)
    expect(retiredFetchIndex).toBeGreaterThan(priorityFetchIndex)
    expect(plan).toContain(
      "ALTER TABLE pgboss_upgrade_test.version ADD COLUMN IF NOT EXISTS reindex_on"
    )
    expect(plan).toContain(
      "ALTER TABLE pgboss_upgrade_test.version ADD COLUMN IF NOT EXISTS monitor_backoff_on"
    )
    expect(plan).toContain(
      "ALTER TABLE pgboss_upgrade_test.queue ADD COLUMN IF NOT EXISTS monitor_claim_on"
    )
    expect(plan).toContain(
      "UPDATE pgboss_upgrade_test.queue SET monitor_claim_on = monitor_on WHERE monitor_claim_on IS NULL"
    )
    expect(plan).toContain("UPDATE pgboss_upgrade_test.version SET version = '40'")
  })
})
