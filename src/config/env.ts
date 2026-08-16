import { z } from "zod"

/** Raw string flag consumed by src/pipeline/flags.ts, which owns the semantics. */
const cutoverFlag = z.string().optional()

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
   * Per-job-family cutover flags (U12 worker semantics, see src/pipeline/flags.ts):
   * production installs a family only when its flag is the exact string "true";
   * outside production a family is enabled unless the flag is exactly "false".
   * This is the single-writer guard: an unflagged family gets no queues,
   * schedules, or workers at boot.
   */
  CUTOVER_SCRAPE: cutoverFlag,
  CUTOVER_TAG: cutoverFlag,
  CUTOVER_REVIEW: cutoverFlag,
  CUTOVER_DIGEST: cutoverFlag,
  CUTOVER_REMINDERS: cutoverFlag,
  CUTOVER_NOTIFY: cutoverFlag,
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
