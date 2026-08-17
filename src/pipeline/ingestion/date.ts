// Wall-clock date helpers for source parsers. Ported from family-events-backend
// supabase/functions/scrape-source/lib/date.ts (U28). Deviation (PR #14
// review): wall-clock parts are validated against the real calendar before
// Date.UTC construction. Under fallback "null" (and in
// dateStampToWallClockIso) impossible components now return null; the default
// "utc" fallback keeps the legacy rollover because its overload guarantees a
// string to the parsers — ingestion-entry rejection of impossible ISO strings
// lives in validateParsedEvents.

import { calendarComponentsValid } from "./parsing.js"

interface WallClockParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second?: number
}

interface WallClockOptions {
  fallback?: "utc" | "null"
}

export function parseDateFromText(value: string): string | null {
  const datePattern =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/i

  const match = value.match(datePattern)
  if (!match) {
    return null
  }

  const parsed = new Date(match[0])
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed.toISOString()
}

export function getTimeZoneOffset(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })

  const parts = formatter.formatToParts(date)
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value)

  const asUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    pick("hour"),
    pick("minute"),
    pick("second")
  )

  return asUtc - date.getTime()
}

export function wallClockToIso(
  parts: WallClockParts,
  timeZone: string,
  options?: { fallback?: "utc" }
): string
export function wallClockToIso(
  parts: WallClockParts,
  timeZone: string,
  options: { fallback: "null" }
): string | null
export function wallClockToIso(
  { year, month, day, hour, minute, second = 0 }: WallClockParts,
  timeZone: string,
  { fallback = "utc" }: WallClockOptions = {}
): string | null {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second)

  if (!calendarComponentsValid(year, month, day, hour, minute, second)) {
    return fallback === "null" ? null : new Date(utcGuess).toISOString()
  }

  try {
    const initialOffset = getTimeZoneOffset(new Date(utcGuess), timeZone)
    let adjusted = utcGuess - initialOffset
    const followupOffset = getTimeZoneOffset(new Date(adjusted), timeZone)
    if (followupOffset !== initialOffset) {
      adjusted = utcGuess - followupOffset
    }
    return new Date(adjusted).toISOString()
  } catch {
    return fallback === "null" ? null : new Date(utcGuess).toISOString()
  }
}

export function dateStampToWallClockIso(
  dateStamp: string,
  hour: number,
  minute: number,
  timeZone: string
): string | null {
  const match = dateStamp.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!match) {
    return null
  }

  const [, year, month, day] = match
  if (!calendarComponentsValid(Number(year), Number(month), Number(day), hour, minute)) {
    return null
  }
  return wallClockToIso(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour,
      minute,
    },
    timeZone
  )
}
