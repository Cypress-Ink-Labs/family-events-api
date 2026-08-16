import { z } from "zod"

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  /** Postgres connection string. Points at the same database the old pipeline writes to. */
  DATABASE_URL: z.string().min(1),
  /** Schema pg-boss manages for its own tables. Matches the U12 worker's schema. */
  PGBOSS_SCHEMA: z.string().default("pgboss"),
  /** Clerk secret key. Required outside tests; endpoints behind ClerkAuthGuard fail closed without it. */
  CLERK_SECRET_KEY: z.string().optional(),
  /**
   * Comma-separated list of family slugs this instance is allowed to write for.
   * Mirrors the per-family CUTOVER_<FAMILY> creation-time guards from the app worker:
   * a family absent from this list gets no schedules/jobs installed at boot.
   */
  CUTOVER_FAMILIES: z.string().default(""),
})

export type Env = z.infer<typeof envSchema>

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")
    throw new Error(`Invalid environment: ${issues}`)
  }
  return parsed.data
}

export function cutoverFamilies(env: Env): ReadonlySet<string> {
  return new Set(
    env.CUTOVER_FAMILIES.split(",")
      .map((slug) => slug.trim().toLowerCase())
      .filter((slug) => slug.length > 0)
  )
}
