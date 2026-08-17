// Pure parsing helpers for source ingestion. Ported from family-events-backend
// supabase/functions/_shared/parsing.ts (U28). Deviations (PR #14 review):
// impossible calendar components (e.g. Feb 30) are rejected instead of letting
// Date roll them into a different valid date, iCal escapes are parsed in one
// pass, negated "free" wording no longer classifies as free admission, and
// dedup keys normalize valid timestamps to UTC before minute-slicing.

/** True when the components form a real calendar date/time (no rollover). */
export function calendarComponentsValid(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (month < 1 || month > 12) return false
  // Day zero of the next month = last day of this month.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > daysInMonth) return false
  if (hour < 0 || hour > 23) return false
  if (minute < 0 || minute > 59) return false
  if (second < 0 || second > 59) return false
  return true
}

const ISO_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/

/**
 * For ISO-shaped strings, verify the calendar components are real before any
 * Date construction (Date.parse rolls 2026-02-30 into 2026-03-02). Non-ISO
 * shapes return true — Date parsing remains the judge for those.
 */
export function isoCalendarComponentsValid(value: string): boolean {
  const match = value.match(ISO_PREFIX)
  if (!match) return true
  return calendarComponentsValid(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? 0 : Number(match[4]),
    match[5] === undefined ? 0 : Number(match[5]),
    match[6] === undefined ? 0 : Number(match[6])
  )
}

export function parseIsoDate(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  if (!isoCalendarComponentsValid(value)) {
    return null
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed.toISOString()
}

export function parseIcalDate(value: string | null): string | null {
  if (!value) {
    return null
  }

  const compact = value.trim()
  if (/^\d{8}$/.test(compact)) {
    const year = compact.slice(0, 4)
    const month = compact.slice(4, 6)
    const day = compact.slice(6, 8)
    if (!calendarComponentsValid(Number(year), Number(month), Number(day))) return null
    return new Date(`${year}-${month}-${day}T00:00:00Z`).toISOString()
  }

  if (/^\d{8}T\d{6}Z?$/.test(compact)) {
    const year = compact.slice(0, 4)
    const month = compact.slice(4, 6)
    const day = compact.slice(6, 8)
    const hour = compact.slice(9, 11)
    const minute = compact.slice(11, 13)
    const second = compact.slice(13, 15)
    if (
      !calendarComponentsValid(
        Number(year),
        Number(month),
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      )
    ) {
      return null
    }
    // Timezone-less iCal is treated as UTC for consistent behaviour across
    // server environments (same as the explicit-Z form).
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).toISOString()
  }

  return parseIsoDate(compact)
}

export function decodeHtml(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "...",
    laquo: "<<",
    ldquo: '"',
    lsquo: "'",
    mdash: "-",
    nbsp: " ",
    ndash: "-",
    quot: '"',
    raquo: ">>",
    rdquo: '"',
    rsquo: "'",
    shy: "",
    times: "x",
    lt: "<",
  }

  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      const codePoint = parseInt(hex, 16)
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const codePoint = parseInt(dec, 10)
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match, entityName) => {
      return namedEntities[entityName.toLowerCase()] ?? match
    })
}

export function normalizeExtractedText(value: string): string {
  return decodeHtml(value)
    .replaceAll("\u00a0", " ")
    .replace(/[–—]/g, "-")
    .replaceAll(/\s+/g, " ")
    .replace(
      /([a-z0-9).!?])\s*(Spring Dates|Dates|Date|Time|Location|Meeting Point|Where|When|Cost|About|Themes|What to Bring):/gi,
      "$1 $2:"
    )
    .replace(
      /\b([AP])\.?M\.?\s*(Spring Dates|Dates|Date|Time|Location|Meeting Point|Where|When|Cost|About|Themes|What to Bring):/gi,
      "$1M $2:"
    )
    .trim()
}

/**
 * Unescape iCal (RFC 5545 §3.3.11) text values: \n, \N → space, \, → comma,
 * \; → semicolon, \\ → backslash. Leaves other sequences as-is. Single-pass
 * token replacement so an escaped backslash followed by "n" stays a literal
 * backslash + n instead of being re-read as a newline escape.
 */
export function unescapeIcalText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_match, escaped: string) => {
    if (escaped === "n" || escaped === "N") return " "
    return escaped
  })
}

export function stripHtml(value: string): string {
  return normalizeExtractedText(value.replaceAll(/<[^>]*>/g, " "))
}

/**
 * Strip WordPress / Divi shortcodes like `[et_pb_section …]` and `[/et_pb_section]`.
 * Sources scraped from Divi-built WordPress sites leak these into the description
 * column otherwise. Conservative — only matches `[name …]` where name is
 * alphanumeric + underscore so user-written `[notes]` prose survives.
 */
export function stripShortcodes(value: string): string {
  return (
    value
      .replace(/\[\/?et_pb_[a-z0-9_]*[^\]]*\]/gis, "")
      // Truncated trailing Divi shortcode (no closing `]`) — historic ingest
      // sliced raw description to 500 chars before cleaning and left rows like
      // `…[et_pb_image src="…" title_text="…"` in the DB. The closed-bracket
      // rule above misses these.
      .replace(/\[\/?et_pb_[a-z0-9_]*[^\]]*$/is, "")
      // Lowercase-only shortcode names so user prose like `[See details]` survives.
      .replace(/\[\/?[a-z][a-z0-9_]*(?:\s[^\]]*)?\]/gs, "")
      // Trailing unclosed generic shortcode (requires whitespace after the
      // name so we don't eat user prose like `[See details` at end-of-string).
      .replace(/\[\/?[a-z][a-z0-9_]*\s[^\]]*$/s, "")
  )
}

/**
 * Full description cleanup: strip shortcodes, then strip HTML + normalize.
 * Use at ingest time so the DB row holds presentable text and clients
 * don't have to re-sanitize on every render.
 */
export function cleanDescription(value: string | null | undefined): string {
  if (!value) {
    return ""
  }
  return stripHtml(stripShortcodes(value))
}

export function extractPrice(text: string): { price: number | null; isFree: boolean } {
  const lower = text.toLowerCase()

  const priceMatch = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/)

  // Negated "free" wording is not free admission; when a dollar amount is
  // present it wins, otherwise fall through as unknown price.
  const negatedFreePatterns = [/\bnot\s+free\b/, /\bisn'?t\s+free\b/, /\bno\s+longer\s+free\b/]
  const negatedFree = negatedFreePatterns.some((pattern) => pattern.test(lower))

  if (!negatedFree) {
    const freePatterns = [
      /\bfree\b/,
      /\bno cost\b/,
      /\bno charge\b/,
      /\bcomplimentary\b/,
      /\bfree admission\b/,
      /\bfree event\b/,
    ]
    for (const pattern of freePatterns) {
      if (pattern.test(lower)) {
        return { price: null, isFree: true }
      }
    }
  }

  if (priceMatch) {
    return { price: Number(priceMatch[1]), isFree: false }
  }

  return { price: null, isFree: false }
}

/**
 * Normalize a timestamp to its UTC ISO minute for key building: equivalent
 * instants written with different offsets collapse to one key. Invalid input
 * falls back to raw slicing (never throws).
 */
export function utcMinute(startDatetime: string): string {
  const parsed = new Date(startDatetime)
  if (Number.isNaN(parsed.getTime())) return startDatetime.slice(0, 16)
  return parsed.toISOString().slice(0, 16)
}

/**
 * Build a dedup key for cross-source event detection.
 * Same title + same start minute + same city = same event regardless of source.
 */
export function dedupKey(title: string, startDatetime: string, cityId: string | null): string {
  const normalizedTitle = title.trim().toLowerCase()
  // Truncate to minute precision to handle minor ISO format variations
  const minute = utcMinute(startDatetime)
  return `${cityId ?? "null"}::${minute}::${normalizedTitle}`
}
