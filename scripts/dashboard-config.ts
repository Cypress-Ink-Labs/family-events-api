export type DashboardEnvironment = NodeJS.ProcessEnv

export class DashboardConfigurationError extends Error {
  constructor(variable: string) {
    super(`Invalid dashboard configuration: ${variable}`)
    this.name = "DashboardConfigurationError"
  }
}

function reject(variable: string): never {
  throw new DashboardConfigurationError(variable)
}

function requireNonEmpty(env: DashboardEnvironment, variable: string): string {
  const value = env[variable]
  if (value === undefined || value.length === 0 || value.trim() !== value) reject(variable)
  return value
}

export function validateDashboardConfiguration(
  env: DashboardEnvironment,
  nodeVersion = process.versions.node
): void {
  const nodeMajor = Number.parseInt(nodeVersion.split(".", 1)[0] ?? "", 10)
  if (!Number.isInteger(nodeMajor) || nodeMajor < 24) reject("NODE_VERSION")

  const databaseUrl = requireNonEmpty(env, "DATABASE_URL")
  try {
    const parsed = new URL(databaseUrl)
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") reject("DATABASE_URL")
    if (!parsed.hostname || !parsed.username || !parsed.password || parsed.pathname === "/") {
      reject("DATABASE_URL")
    }
  } catch {
    reject("DATABASE_URL")
  }

  if (requireNonEmpty(env, "PGBOSS_SCHEMA") !== "pgboss") reject("PGBOSS_SCHEMA")
  const username = requireNonEmpty(env, "PGBOSS_DASHBOARD_AUTH_USERNAME")
  const password = requireNonEmpty(env, "PGBOSS_DASHBOARD_AUTH_PASSWORD")
  if (username === password) reject("PGBOSS_DASHBOARD_AUTH_PASSWORD")
  if (env.PGBOSS_DASHBOARD_READ_ONLY !== "1") reject("PGBOSS_DASHBOARD_READ_ONLY")
  requireNonEmpty(env, "HOST")

  const port = requireNonEmpty(env, "PORT")
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65_535) reject("PORT")
}
