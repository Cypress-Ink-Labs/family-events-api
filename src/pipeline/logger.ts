// Structured pipeline logger, ported verbatim from family-events-backend
// supabase/functions/_shared/logger.ts (U28). The name logEdgeEvent is kept so
// ported pipeline code stays byte-comparable with upstream; the JSON console
// payloads match what the legacy edge functions emitted, which keeps log
// dashboards working across the cutover. The PostgrestError branch also
// matches node-postgres DatabaseError (a real Error whose code/details live on
// the instance), so pg errors serialize with their SQLSTATE either way.

export type EdgeLogLevel = "log" | "warn" | "error"

interface EdgeLogContext {
  [key: string]: unknown
}

interface PostgrestErrorShape {
  code?: unknown
  message?: unknown
  details?: unknown
  hint?: unknown
}

function looksLikePostgrestError(value: unknown): value is PostgrestErrorShape {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  // PostgrestError-shaped: plain object exposing code + message + details/hint.
  return (
    typeof v.code === "string" && typeof v.message === "string" && ("details" in v || "hint" in v)
  )
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    const details = error as Error & { code?: string; status?: number }
    return {
      message: error.message,
      name: error.name,
      code: details.code ?? null,
      status: details.status ?? null,
      stack: error.stack ?? null,
    }
  }

  // PostgrestError isn't an Error instance — it's a plain object with code,
  // message, details, hint. Before this branch, every supabase-js error was
  // being stringified as "[object Object]" which made production debugging
  // impossible.
  if (looksLikePostgrestError(error)) {
    const e = error as Record<string, unknown>
    return {
      message: typeof e.message === "string" ? e.message : String(e.message ?? ""),
      name: "PostgrestError",
      code: typeof e.code === "string" ? e.code : null,
      status: typeof e.status === "number" ? e.status : null,
      details: typeof e.details === "string" ? e.details : null,
      hint: typeof e.hint === "string" ? e.hint : null,
      stack: null,
    }
  }

  // Last-resort: try JSON, fall back to String. Plain-object errors don't
  // stringify as "[object Object]" anymore.
  let rendered: string
  try {
    rendered = typeof error === "string" ? error : JSON.stringify(error)
    if (rendered === "{}" || rendered === undefined) {
      rendered = String(error)
    }
  } catch {
    rendered = String(error)
  }

  return {
    message: rendered,
    name: "UnknownError",
    code: null,
    status: null,
    stack: null,
  }
}

export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

export function errorMessage(error: unknown): string {
  // Single-line summary suitable for last_error text columns / log fields.
  // Handles PostgrestError (plain object with code/message/details/hint) so
  // we never write the literal "[object Object]" again.
  const s = serializeError(error)
  const parts = [s.message]
  if (s.code) parts.push(`code=${s.code}`)
  const details = (s as { details?: string | null }).details
  if (details) parts.push(`details=${details}`)
  return parts.filter(Boolean).join(" ")
}

export function logEdgeEvent(level: EdgeLogLevel, message: string, context: EdgeLogContext = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  }

  console[level](JSON.stringify(payload))
}

export function errorContext(error: unknown, extra: EdgeLogContext = {}) {
  return {
    ...extra,
    error: serializeError(error),
  }
}
