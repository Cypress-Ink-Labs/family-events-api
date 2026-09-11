const REDACTED = "[REDACTED]"
const TRUNCATED = "[TRUNCATED]"

const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|headers?|cookie|cookies|set-cookie|query|query_string|database_url|connection(string|_string)?|password|passwd|token|secret|api[-_]?key|clerk.*|sentry.*dsn|code|body|payload|content|html|text)$/i
const SENSITIVE_KEY_PART =
  /(password|passwd|credential|secret|token|api[-_]?key|private[-_]?key|clerk|database[-_]?url|connection[-_]?string|sentry[-_]?dsn|email.*(?:payload|content|body|html|text))/i
const CONNECTION_VALUE = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^/\s]+@/i
const SENTRY_DSN_VALUE = /\bhttps?:\/\/[^@\s/]+@[^/\s]+\/\d+\b/i
const INVITE_CODE_VALUE = /\b[A-HJ-NP-Z2-9]{24}\b/

export interface RedactionOptions {
  maxDepth?: number
  maxArrayLength?: number
  maxObjectKeys?: number
  maxStringLength?: number
  sensitiveValues?: readonly string[]
}

/** A bounded, cycle-safe policy shared by telemetry today and structured logs later. */
export function redact(value: unknown, options: RedactionOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 6
  const maxArrayLength = options.maxArrayLength ?? 50
  const maxObjectKeys = options.maxObjectKeys ?? 100
  const maxStringLength = options.maxStringLength ?? 2_000
  const sensitiveValues = (options.sensitiveValues ?? []).filter(Boolean)
  const seen = new WeakSet<object>()

  const visit = (current: unknown, depth: number, key?: string): unknown => {
    if (key && (SENSITIVE_KEY.test(key) || SENSITIVE_KEY_PART.test(key))) return REDACTED
    if (typeof current === "string") {
      if (
        CONNECTION_VALUE.test(current) ||
        SENTRY_DSN_VALUE.test(current) ||
        INVITE_CODE_VALUE.test(current) ||
        sensitiveValues.some((secret) => current.includes(secret))
      )
        return REDACTED
      return current.length > maxStringLength
        ? `${current.slice(0, maxStringLength)}${TRUNCATED}`
        : current
    }
    if (typeof current === "bigint") return current.toString()
    if (current instanceof Error) {
      return visit(
        {
          name: current.name,
          message: current.message,
          code: (current as Error & { code?: unknown }).code,
        },
        depth,
        key
      )
    }
    if (current === null || typeof current !== "object") return current
    if (depth >= maxDepth) return TRUNCATED
    if (seen.has(current)) return "[CIRCULAR]"
    seen.add(current)
    if (Array.isArray(current)) {
      const result = current.slice(0, maxArrayLength).map((item) => visit(item, depth + 1))
      if (current.length > maxArrayLength) result.push(TRUNCATED)
      return result
    }
    const result: Record<string, unknown> = {}
    const entries = Object.entries(current as Record<string, unknown>)
    for (const [childKey, child] of entries.slice(0, maxObjectKeys)) {
      result[childKey] = visit(child, depth + 1, childKey)
    }
    if (entries.length > maxObjectKeys) result.__truncated__ = TRUNCATED
    return result
  }

  return visit(value, 0)
}

export const REDACTED_VALUE = REDACTED
