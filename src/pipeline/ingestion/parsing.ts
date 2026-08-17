// Pure parsing helpers for source ingestion. Ported verbatim from
// family-events-backend supabase/functions/_shared/parsing.ts (U28).

export function parseIsoDate(value: string | null | undefined): string | null {
  if (!value) {
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
    return new Date(`${year}-${month}-${day}T00:00:00Z`).toISOString()
  }

  if (/^\d{8}T\d{6}Z$/.test(compact)) {
    const year = compact.slice(0, 4)
    const month = compact.slice(4, 6)
    const day = compact.slice(6, 8)
    const hour = compact.slice(9, 11)
    const minute = compact.slice(11, 13)
    const second = compact.slice(13, 15)
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).toISOString()
  }

  if (/^\d{8}T\d{6}$/.test(compact)) {
    const year = compact.slice(0, 4)
    const month = compact.slice(4, 6)
    const day = compact.slice(6, 8)
    const hour = compact.slice(9, 11)
    const minute = compact.slice(11, 13)
    const second = compact.slice(13, 15)
    // Treat timezone-less iCal as UTC for consistent behaviour across server environments
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
 * Unescape iCal (RFC 5545 §3.3.11) text values: \n, \N → newline, \, → comma,
 * \; → semicolon, \\ → backslash. Leaves other sequences as-is.
 */
export function unescapeIcalText(value: string): string {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
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

  const priceMatch = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/)
  if (priceMatch) {
    return { price: Number(priceMatch[1]), isFree: false }
  }

  return { price: null, isFree: false }
}

/**
 * Build a dedup key for cross-source event detection.
 * Same title + same start minute + same city = same event regardless of source.
 */
export function dedupKey(title: string, startDatetime: string, cityId: string | null): string {
  const normalizedTitle = title.trim().toLowerCase()
  // Truncate to minute precision to handle minor ISO format variations
  const minute = startDatetime.slice(0, 16)
  return `${cityId ?? "null"}::${minute}::${normalizedTitle}`
}
