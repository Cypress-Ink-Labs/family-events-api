/**
 * Zone-local day and weekend window math.
 * Ported verbatim from family-events-backend supabase/functions/_shared/zoned-time.ts
 * (plan 031 semantics: Friday-to-Monday zone-local weekend, half-open, DST-safe).
 *
 * NOTE: Callers like reminders hardcode a single timezone. If multi-region
 * support is ever added, callers must pass the per-event or per-user timezone
 * and the single-global-window query approach will need to change accordingly.
 */
interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: string
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(date)

  const getNumber = (type: string) => {
    const part = parts.find((candidate) => candidate.type === type)
    if (!part) throw new Error(`Intl part "${type}" missing for timezone "${timeZone}"`)
    return parseInt(part.value, 10)
  }
  const getText = (type: string) => {
    const part = parts.find((candidate) => candidate.type === type)
    if (!part) throw new Error(`Intl part "${type}" missing for timezone "${timeZone}"`)
    return part.value
  }

  return {
    year: getNumber("year"),
    month: getNumber("month") - 1,
    day: getNumber("day"),
    hour: getNumber("hour"),
    minute: getNumber("minute"),
    second: getNumber("second"),
    weekday: getText("weekday"),
  }
}

function offsetAt(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone)
  const wallAsUtcMs = Date.UTC(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )
  return wallAsUtcMs - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * Returns the UTC Date for midnight (00:00:00) of the zone-local calendar day
 * at (now + dayOffset days). dayOffset 0 = start of the current zone-local day.
 */
export function zonedDayStartUtc(now: Date, timeZone: string, dayOffset: number): Date {
  const localNow = getZonedParts(now, timeZone)
  const targetWallMidnightMs = Date.UTC(localNow.year, localNow.month, localNow.day + dayOffset)

  // Resolve the offset at the target local day rather than reusing today's
  // offset. A first estimate locates the target day; its wall-clock parts then
  // yield the offset that applies at that day's midnight.
  const estimatedUtc = new Date(targetWallMidnightMs - offsetAt(now, timeZone))
  return new Date(targetWallMidnightMs - offsetAt(estimatedUtc, timeZone))
}

/** Upcoming-weekend window as UTC instants: [Friday 00:00, Monday 00:00) zone-local. */
export function weekendWindowUtc(now: Date, timeZone: string): { from: Date; to: Date } {
  const weekday = getZonedParts(now, timeZone).weekday
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday)
  if (weekdayIndex === -1) {
    throw new Error(`Unrecognized weekday "${weekday}" for timezone "${timeZone}"`)
  }

  const fridayOffset = weekdayIndex === 0 ? -2 : weekdayIndex === 6 ? -1 : 5 - weekdayIndex
  return {
    from: zonedDayStartUtc(now, timeZone, fridayOffset),
    to: zonedDayStartUtc(now, timeZone, fridayOffset + 3),
  }
}
