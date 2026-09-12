import type { ChildProcess } from "node:child_process"
import { createServer } from "node:net"

import { PgBoss } from "pg-boss"
import { Pool } from "pg"
import { describe, expect, it } from "vitest"

import { spawnInstalledDashboard } from "../../scripts/start-pgboss-dashboard.js"
import { integrationDatabaseUrl } from "./db.js"

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Failed to reserve a port")
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()))
  })
  return address.port
}

async function waitForDashboard(child: ChildProcess, port: number): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup()
      rejectReady(new Error("Dashboard readiness timed out"))
    }, 10_000)
    const expected = `@pg-boss/dashboard@1.7.0 listening on http://127.0.0.1:${port}`
    const onData = (chunk: Buffer | string) => {
      if (String(chunk).includes(expected)) {
        cleanup()
        resolveReady()
      }
    }
    const onExit = () => {
      cleanup()
      rejectReady(new Error("Dashboard exited before readiness"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout?.off("data", onData)
      child.off("exit", onExit)
    }
    child.stdout?.on("data", onData)
    child.once("exit", onExit)
  })
}

function dashboardFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(5_000) })
}

async function stopDashboard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ])
  if (exited) return
  child.kill("SIGKILL")
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Dashboard process did not stop")), 5_000)
    ),
  ])
}

async function databaseFingerprint(pool: Pool, schema: string): Promise<Record<string, unknown>[]> {
  return (
    await pool.query(
      `
        SELECT
          (SELECT md5(COALESCE(jsonb_agg(to_jsonb(v) ORDER BY version)::text, '[]'))
           FROM "${schema}".version v) AS version_rows,
          (SELECT md5(COALESCE(jsonb_agg(to_jsonb(q) ORDER BY name)::text, '[]'))
           FROM "${schema}".queue q) AS queue_rows,
          (SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY name, key)::text, '[]'))
           FROM "${schema}".schedule s) AS schedule_rows,
          (SELECT md5(COALESCE(jsonb_agg(to_jsonb(j) ORDER BY id)::text, '[]'))
           FROM "${schema}".job_common j) AS job_rows,
          (SELECT md5(COALESCE(jsonb_agg(to_jsonb(b) ORDER BY id)::text, '[]'))
           FROM "${schema}".bam b) AS bam_rows,
          (SELECT md5(COALESCE(string_agg(indexname || ':' || indexdef, E'\\n' ORDER BY indexname), ''))
           FROM pg_indexes WHERE schemaname = $1) AS indexes,
          (SELECT md5(COALESCE(string_agg(
             table_name || ':' || column_name || ':' || data_type,
             E'\\n' ORDER BY table_name, ordinal_position
           ), '')) FROM information_schema.columns WHERE table_schema = $1) AS columns,
          (SELECT md5(COALESCE(string_agg(
             p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || pg_get_functiondef(p.oid),
             E'\\n' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
           ), ''))
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = $1) AS functions
      `,
      [schema]
    )
  ).rows
}

describe("@pg-boss/dashboard read-only service", () => {
  it("requires Basic Auth, permits reads, and rejects every mutation method", async () => {
    const connectionString = integrationDatabaseUrl()
    const schema = "pgboss"
    const username = "integration-operator"
    const password = "integration-password"
    const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
    const port = await availablePort()
    const pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    })
    let boss: PgBoss | null = new PgBoss({ connectionString, schema })
    let child: ChildProcess | null = null
    let childStderr = ""
    let primaryFailure: unknown
    const cleanupErrors: unknown[] = []

    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await boss.start()
      await boss.createQueue("dashboard-check")
      await boss.schedule(
        "dashboard-check",
        "0 0 1 1 *",
        { marker: "scheduled" },
        { key: "dashboard-check-schedule" }
      )
      await boss.send("dashboard-check", { marker: "queued" })
      await boss.stop({ close: true })
      boss = null

      const before = await databaseFingerprint(pool, schema)

      child = spawnInstalledDashboard(
        {
          NODE_ENV: "test",
          DATABASE_URL: connectionString,
          PGBOSS_SCHEMA: schema,
          PGBOSS_DASHBOARD_AUTH_USERNAME: username,
          PGBOSS_DASHBOARD_AUTH_PASSWORD: password,
          PGBOSS_DASHBOARD_READ_ONLY: "1",
          HOST: "127.0.0.1",
          PORT: String(port),
        },
        "24.0.0",
        ["ignore", "pipe", "pipe"]
      )
      child.stderr?.on("data", (chunk: Buffer | string) => {
        childStderr = `${childStderr}${String(chunk)}`.slice(-65_536)
      })
      await waitForDashboard(child, port)

      const origin = `http://127.0.0.1:${port}`
      const unauthorized = await dashboardFetch(`${origin}/queues`)
      expect(unauthorized.status).toBe(401)
      expect(unauthorized.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')

      const invalidAuth = `Basic ${Buffer.from("wrong:credentials").toString("base64")}`
      const invalid = await dashboardFetch(`${origin}/queues`, {
        headers: { authorization: invalidAuth },
      })
      expect(invalid.status).toBe(401)

      for (const path of ["/", "/queues", "/jobs", "/schedules"]) {
        const response = await dashboardFetch(`${origin}${path}`, {
          headers: { authorization: auth },
        })
        expect(response.status).toBe(200)
        if (path === "/queues") expect(await response.text()).toContain("dashboard-check")
      }

      for (const [method, path] of [
        ["POST", "/queues/create"],
        ["POST", "/send"],
        ["POST", "/schedules/new"],
        ["PUT", "/queues/dashboard-check"],
        ["PATCH", "/queues/dashboard-check"],
        ["DELETE", "/queues/dashboard-check"],
        ["OPTIONS", "/queues/dashboard-check"],
      ] as const) {
        const response = await dashboardFetch(`${origin}${path}`, {
          method,
          headers: { authorization: auth },
        })
        expect(response.status).toBe(403)
        expect(await response.text()).toBe(
          "This dashboard is read-only (PGBOSS_DASHBOARD_READ_ONLY=1)."
        )
      }

      expect(await databaseFingerprint(pool, schema)).toEqual(before)

      await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
      const unavailable = await dashboardFetch(`${origin}/jobs`, {
        headers: { authorization: auth },
      })
      expect(unavailable.status).toBeGreaterThanOrEqual(500)
      const unavailableBody = await unavailable.text()
      for (const secret of [connectionString, password, auth]) {
        expect(unavailableBody).not.toContain(secret)
        expect(childStderr).not.toContain(secret)
      }
    } catch (error) {
      primaryFailure = error
    } finally {
      if (child !== null) await stopDashboard(child).catch((error) => cleanupErrors.push(error))
      if (boss !== null) {
        await boss.stop({ close: true }).catch((error) => cleanupErrors.push(error))
      }
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } catch (error) {
        cleanupErrors.push(error)
      } finally {
        await pool.end().catch((error) => cleanupErrors.push(error))
      }
    }
    if (primaryFailure !== undefined) throw primaryFailure
    if (cleanupErrors[0]) throw cleanupErrors[0]
  }, 75_000)
})
