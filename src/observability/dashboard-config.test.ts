import { EventEmitter } from "node:events"

import type { ChildProcess } from "node:child_process"
import { describe, expect, it, vi } from "vitest"

import {
  DashboardConfigurationError,
  validateDashboardConfiguration,
} from "../../scripts/dashboard-config.js"
import {
  resolveInstalledDashboardCli,
  startDashboard,
  superviseDashboardProcess,
} from "../../scripts/start-pgboss-dashboard.js"

const valid = {
  DATABASE_URL: "postgresql://dashboard:secret@127.0.0.1:5432/postgres",
  PGBOSS_SCHEMA: "pgboss",
  PGBOSS_DASHBOARD_AUTH_USERNAME: "operator",
  PGBOSS_DASHBOARD_AUTH_PASSWORD: "different-secret",
  PGBOSS_DASHBOARD_READ_ONLY: "1",
  HOST: "0.0.0.0",
  PORT: "3000",
}

describe("dashboard configuration", () => {
  it("accepts the fail-closed production contract on Node 24+", () => {
    expect(() => validateDashboardConfiguration(valid, "24.0.0")).not.toThrow()
    expect(() => validateDashboardConfiguration(valid, "26.1.0")).not.toThrow()
  })

  it.each([
    ["NODE_VERSION", valid, "23.11.0"],
    ["DATABASE_URL", { ...valid, DATABASE_URL: "" }, "24.0.0"],
    ["DATABASE_URL", { ...valid, DATABASE_URL: "https://example.com" }, "24.0.0"],
    ["DATABASE_URL", { ...valid, DATABASE_URL: "postgresql://" }, "24.0.0"],
    ["DATABASE_URL", { ...valid, DATABASE_URL: "postgresql://user:password@db/" }, "24.0.0"],
    ["PGBOSS_SCHEMA", { ...valid, PGBOSS_SCHEMA: "public" }, "24.0.0"],
    ["PGBOSS_DASHBOARD_AUTH_USERNAME", { ...valid, PGBOSS_DASHBOARD_AUTH_USERNAME: "" }, "24.0.0"],
    [
      "PGBOSS_DASHBOARD_AUTH_PASSWORD",
      { ...valid, PGBOSS_DASHBOARD_AUTH_PASSWORD: "operator" },
      "24.0.0",
    ],
    ["PGBOSS_DASHBOARD_READ_ONLY", { ...valid, PGBOSS_DASHBOARD_READ_ONLY: "true" }, "24.0.0"],
    ["HOST", { ...valid, HOST: " " }, "24.0.0"],
    ["PORT", { ...valid, PORT: "0" }, "24.0.0"],
    ["PORT", { ...valid, PORT: "65536" }, "24.0.0"],
    ["PORT", { ...valid, PORT: "03000" }, "24.0.0"],
  ])("rejects invalid %s without exposing its value", (variable, env, nodeVersion) => {
    let thrown: unknown
    try {
      validateDashboardConfiguration(env, nodeVersion)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DashboardConfigurationError)
    expect((thrown as Error).message).toBe(`Invalid dashboard configuration: ${variable}`)
    expect((thrown as Error).message).not.toContain(valid.DATABASE_URL)
    expect((thrown as Error).message).not.toContain(valid.PGBOSS_DASHBOARD_AUTH_PASSWORD)
  })

  it("validates before loading the dashboard package", async () => {
    const loadDashboard = vi.fn(async () => undefined)
    await expect(
      startDashboard({ ...valid, PGBOSS_DASHBOARD_READ_ONLY: "0" }, "24.0.0", loadDashboard)
    ).rejects.toThrow("PGBOSS_DASHBOARD_READ_ONLY")
    expect(loadDashboard).not.toHaveBeenCalled()

    await startDashboard(valid, "24.0.0", loadDashboard)
    expect(loadDashboard).toHaveBeenCalledOnce()
  })

  it("resolves the installed package's declared CLI", () => {
    expect(resolveInstalledDashboardCli()).toMatch(/@pg-boss[/\\]dashboard[/\\]bin[/\\]cli\.js$/)
  })

  it("forwards termination and force-kills on a repeated signal", async () => {
    const signals = new EventEmitter()
    const child = new EventEmitter() as ChildProcess
    Object.defineProperties(child, {
      exitCode: { configurable: true, value: null, writable: true },
      signalCode: { configurable: true, value: null, writable: true },
    })
    child.kill = vi.fn(() => true)

    const supervised = superviseDashboardProcess(
      child,
      signals as unknown as Pick<NodeJS.Process, "on" | "off">
    )
    signals.emit("SIGTERM")
    signals.emit("SIGTERM")
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM")
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL")

    Object.defineProperty(child, "signalCode", { value: "SIGTERM", writable: true })
    child.emit("exit", null, "SIGTERM")
    await supervised
    expect(signals.listenerCount("SIGTERM")).toBe(0)
  })
})
