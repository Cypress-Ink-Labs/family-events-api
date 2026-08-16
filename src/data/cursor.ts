const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface EventCursor {
  afterStart: string
  afterId: string
}

export function encodeEventCursor(afterStart: string, afterId: string): string {
  return Buffer.from(
    JSON.stringify({ after_start: afterStart, after_id: afterId }),
    "utf8"
  ).toString("base64")
}

export function decodeEventCursor(raw: string): EventCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("after_start" in decoded) ||
      !("after_id" in decoded) ||
      typeof decoded.after_start !== "string" ||
      typeof decoded.after_id !== "string" ||
      !UUID_PATTERN.test(decoded.after_id) ||
      !Number.isFinite(new Date(decoded.after_start).getTime())
    ) {
      return null
    }
    return { afterStart: decoded.after_start, afterId: decoded.after_id }
  } catch {
    return null
  }
}
