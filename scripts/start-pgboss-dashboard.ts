import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { validateDashboardConfiguration, type DashboardEnvironment } from "./dashboard-config.js"

type DashboardLoader = () => Promise<unknown>

export function resolveInstalledDashboardCli(): string {
  const require = createRequire(__filename)
  const packagePath = require.resolve("@pg-boss/dashboard/package.json")
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
    bin?: { "pg-boss-dashboard"?: unknown }
  }
  const bin = packageJson.bin?.["pg-boss-dashboard"]
  if (typeof bin !== "string") {
    throw new Error("Installed @pg-boss/dashboard package has no pg-boss-dashboard binary")
  }
  return resolve(dirname(packagePath), bin)
}

export function spawnInstalledDashboard(
  env: DashboardEnvironment = process.env,
  nodeVersion = process.versions.node,
  stdio: StdioOptions = "inherit"
): ChildProcess {
  validateDashboardConfiguration(env, nodeVersion)
  return spawn(process.execPath, [resolveInstalledDashboardCli()], {
    env,
    stdio,
  })
}

type SignalSource = Pick<NodeJS.Process, "on" | "off">

export async function superviseDashboardProcess(
  child: ChildProcess,
  signalSource: SignalSource = process
): Promise<void> {
  let stopping = false
  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(stopping ? "SIGKILL" : signal)
    stopping = true
  }
  const onSigint = () => forwardSignal("SIGINT")
  const onSigterm = () => forwardSignal("SIGTERM")
  const onSighup = () => forwardSignal("SIGHUP")
  signalSource.on("SIGINT", onSigint)
  signalSource.on("SIGTERM", onSigterm)
  signalSource.on("SIGHUP", onSighup)
  try {
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once("error", rejectExit)
      child.once("exit", (code, signal) => {
        if (code === 0 || signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP") {
          resolveExit()
        } else rejectExit(new Error("pg-boss dashboard process exited unexpectedly"))
      })
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    signalSource.off("SIGINT", onSigint)
    signalSource.off("SIGTERM", onSigterm)
    signalSource.off("SIGHUP", onSighup)
  }
}

export async function loadInstalledDashboardCli(): Promise<void> {
  await superviseDashboardProcess(spawnInstalledDashboard())
}

export async function startDashboard(
  env: DashboardEnvironment = process.env,
  nodeVersion = process.versions.node,
  loadDashboard: DashboardLoader = loadInstalledDashboardCli
): Promise<void> {
  validateDashboardConfiguration(env, nodeVersion)
  await loadDashboard()
}

const entrypoint = process.argv[1]
if (entrypoint && resolve(entrypoint) === __filename) {
  startDashboard().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Dashboard startup failed"
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
