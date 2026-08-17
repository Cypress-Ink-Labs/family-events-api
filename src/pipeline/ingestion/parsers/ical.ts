// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/ical.ts (U28).
// Deviations for strict noUncheckedIndexedAccess: fold-continuation append reads via ?? "", and
// the split()-destructured property key falls back to "" before toUpperCase(). Upstream's unused
// cleanDescription import is dropped (this repo's lint errors on unused imports).

import { extractPrice, parseIcalDate, stripShortcodes, unescapeIcalText } from "../parsing.js"
import { validateExternalUrl } from "../url-validation.js"
import { wallClockToIso } from "../date.js"
import type { ParsedEvent } from "../types.js"
import type { SourceParser } from "./_lib/types.js"

interface ParsedIcalLine {
  key: string
  params: Map<string, string>
  value: string
}

function unfoldIcalLines(icalContent: string): string[] {
  const lines = icalContent.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  const unfolded: string[] = []
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] = (unfolded[unfolded.length - 1] ?? "") + line.slice(1)
      continue
    }
    unfolded.push(line)
  }
  return unfolded
}

function parseIcalLine(line: string): ParsedIcalLine | null {
  const delimiter = line.indexOf(":")
  if (delimiter <= 0) {
    return null
  }

  const descriptor = line.slice(0, delimiter)
  const value = line.slice(delimiter + 1)
  const [key, ...rawParams] = descriptor.split(";")
  const params = new Map<string, string>()

  for (const rawParam of rawParams) {
    const paramDelimiter = rawParam.indexOf("=")
    if (paramDelimiter <= 0) {
      continue
    }
    const name = rawParam.slice(0, paramDelimiter).toUpperCase()
    const paramValue = rawParam.slice(paramDelimiter + 1)
    params.set(name, paramValue)
  }

  return { key: (key ?? "").toUpperCase(), params, value }
}

function parseIcalDateWithTz(value: string | null, tzid: string | null): string | null {
  if (!value) {
    return null
  }
  const compact = value.trim()
  if (!tzid) {
    return parseIcalDate(compact)
  }

  const dateTimeMatch = compact.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/)
  if (!dateTimeMatch || dateTimeMatch[7] === "Z") {
    return parseIcalDate(compact)
  }

  const [, year, month, day, hour, minute, second] = dateTimeMatch
  return (
    wallClockToIso(
      {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second),
      },
      tzid,
      { fallback: "null" }
    ) ?? parseIcalDate(compact)
  )
}

export function parseIcalFeed(icalContent: string): ParsedEvent[] {
  // Upstream calendar hosts occasionally truncate their HTTP responses
  // mid-stream (observed: libcal returned 23 bytes of a 369KB feed).
  // Without this guard the parser silently emits zero events and the
  // worker reports "no valid events" — which masks the transport bug.
  if (icalContent.includes("BEGIN:VCALENDAR") && !icalContent.includes("END:VCALENDAR")) {
    throw new Error(
      `Truncated iCal feed (received ${icalContent.length} bytes, missing END:VCALENDAR)`
    )
  }

  const unfoldedLines = unfoldIcalLines(icalContent)
  const blocks: string[][] = []
  let currentBlock: string[] | null = null

  for (const line of unfoldedLines) {
    if (line === "BEGIN:VEVENT") {
      currentBlock = []
      continue
    }
    if (line === "END:VEVENT") {
      if (currentBlock && currentBlock.length > 0) {
        blocks.push(currentBlock)
      }
      currentBlock = null
      continue
    }
    if (currentBlock) {
      currentBlock.push(line)
    }
  }

  const events: ParsedEvent[] = []

  for (const block of blocks) {
    const parsedLines = block.map(parseIcalLine).filter((line) => line !== null)
    const byKey = new Map<string, ParsedIcalLine[]>()
    for (const line of parsedLines) {
      const existing = byKey.get(line.key) ?? []
      existing.push(line)
      byKey.set(line.key, existing)
    }

    const rawSummary = byKey.get("SUMMARY")?.[0]?.value.trim() ?? ""
    const summary = unescapeIcalText(rawSummary)
    if (!summary) {
      continue
    }

    const rawDescription = byKey.get("DESCRIPTION")?.[0]?.value.trim() ?? ""
    const description = stripShortcodes(unescapeIcalText(rawDescription)).trim()
    const dtStart = byKey.get("DTSTART")?.[0]
    const dtEnd = byKey.get("DTEND")?.[0]
    const dtStartRaw = dtStart?.value.trim() ?? null
    const dtEndRaw = dtEnd?.value.trim() ?? null
    const startTzid = dtStart?.params.get("TZID") ?? null
    const endTzid = dtEnd?.params.get("TZID") ?? null

    const rawLocation = byKey.get("LOCATION")?.[0]?.value.trim() ?? null
    const location = rawLocation ? unescapeIcalText(rawLocation) : null
    // Filter out URLs stored as location (online/virtual events)
    const isLocationUrl = location != null && /^https?:\/\//i.test(location)
    const physicalLocation = isLocationUrl ? null : location
    const url = byKey.get("URL")?.[0]?.value.trim() ?? null

    const startDatetime = parseIcalDateWithTz(dtStartRaw, startTzid)
    if (!startDatetime) {
      continue
    }

    const icalImages: string[] = []
    for (const attach of byKey.get("ATTACH") ?? []) {
      const val = attach.value.trim()
      if (/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)/i.test(val) && validateExternalUrl(val).ok) {
        icalImages.push(val)
      }
    }

    const priceInfo = extractPrice(description)

    events.push({
      title: summary,
      description,
      startDatetime,
      endDatetime: parseIcalDateWithTz(dtEndRaw, endTzid),
      venueName: physicalLocation,
      address: physicalLocation,
      sourceUrl: url,
      imageUrl: icalImages[0] ?? null,
      images: icalImages.slice(0, 5),
      price: priceInfo.price,
      isFree: priceInfo.isFree,
    })
  }

  return events
}

export const icalParser: SourceParser<"ical"> = {
  type: "ical",
  async fetchArtifact(source, ctx) {
    const content = await ctx.fetchText(source.url, {
      accept: "text/calendar,application/calendar+json,*/*",
    })
    return { url: source.url, contentType: "text/calendar", body: content }
  },
  extractEvents(_source, artifact) {
    return Promise.resolve(parseIcalFeed(artifact.body))
  },
}
