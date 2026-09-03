import { z } from "zod"

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
  /** Per-job-family cutover flags. Semantics live in src/pipeline/flags.ts. */
  CUTOVER_SCRAPE: cutoverFlag,
  CUTOVER_TAG: cutoverFlag,
  CUTOVER_REVIEW: cutoverFlag,
  CUTOVER_DIGEST: cutoverFlag,
  CUTOVER_REMINDERS: cutoverFlag,
  CUTOVER_NOTIFY: cutoverFlag,
  /** Shared with user Telegram notifications. Unset disables operator failure pings. */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Operator chat/channel for pipeline failure pings (U3). */
  TELEGRAM_FAILURE_CHAT_ID: z.string().optional(),
  /** OpenWeatherMap key for the plan weather proxy. Unset returns a neutral snapshot. */
  OPENWEATHER_API_KEY: z.string().optional(),
  /** Resend key for reminder and digest emails. Unset makes MailService a logged no-op. */
  RESEND_API_KEY: z.string().optional(),
  /** Verified sender identity; MailService applies the legacy sandbox default when unset. */
  RESEND_FROM: z.string().optional(),
  /** Public app URL used in notification links; notification services apply the legacy default. */
  APP_URL: z.string().optional(),
  /** Public origin of the web app; enables CORS for its browser calls. Unset = no CORS headers. */
  WEB_ORIGIN: z
    .url()
    .transform((origin) => origin.replace(/\/+$/, ""))
    .optional(),
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
