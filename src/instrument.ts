import { envSchema } from "./config/env.js"
import { initializeSentry } from "./observability/sentry.js"

// This module is the first application import in main.ts, as required by Sentry's
// Node instrumentation. Parsing the complete schema also keeps this path aligned
// with Nest's ConfigModule validation; no SDK call occurs without a DSN.
const env = envSchema.parse(process.env)
initializeSentry(env)
