import type { PlannedEvent } from "../data/types.js"

export interface DigestEmailUser {
  displayName: string | null
  cityName: string
}

export interface DigestEvent {
  id: string
  title: string
  startDatetime: string
  venueName: string | null
  address: string | null
  isFree: boolean
  price: string | null
  images: unknown
  explanation: string | null
}

const THEME = {
  bg: "#F5F3FC",
  surface: "#FDFCFF",
  surfaceAlt: "#F2EEFB",
  textPrimary: "#1C1828",
  textMuted: "#6B6278",
  border: "#EAE4F6",
  violet: "#7B5CC8",
  violetDeep: "#5E42A6",
  peach: "#E89060",
  peachDeep: "#C2703B",
  peachSoft: "#FBEDE3",
  blue: "#5A7EA8",
  successText: "#2E7D5B",
  successSoft: "#E6F2EC",
} as const

const FONT_SANS =
  "'DM Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
const FONT_DISPLAY = "'Fraunces', ui-serif, Georgia, 'Times New Roman', serif"
const FONT_EDITORIAL = "'Newsreader', ui-serif, Georgia, 'Times New Roman', serif"
const FONT_MONO = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Newsreader:opsz,wght@6..72,400;6..72,500&family=Geist+Mono:wght@400;500&display=swap"

const FACTOR_LABELS = [
  ["distance_score", "nearby"],
  ["weather_score", "weather fit"],
  ["age_score", "great age match"],
  ["history_affinity", "matches your interests"],
  ["family_fit_score", "family-friendly"],
  ["timing_score", "perfect weekend timing"],
  ["novelty_score", "newly added"],
  ["budget_score", "budget-friendly"],
] as const satisfies ReadonlyArray<[keyof PlannedEvent, string]>

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function buildExplanation(row: PlannedEvent): string | null {
  return (
    FACTOR_LABELS.map(([key, label], order) => ({
      label,
      order,
      value: row[key] == null ? 0 : Number(row[key]),
    }))
      .filter(({ value }) => Number.isFinite(value) && value > 0.5)
      .toSorted((a, b) => b.value - a.value || a.order - b.order)
      .slice(0, 2)
      .map(({ label }) => label)
      .join(" · ") || null
  )
}

function firstImageUrl(images: unknown): string | null {
  if (!Array.isArray(images)) return null
  const first: unknown = images[0]
  if (typeof first === "string") return first
  if (first && typeof first === "object" && "url" in first && typeof first.url === "string") {
    return first.url
  }
  return null
}

function splitDateTime(isoDate: string): { date: string; time: string } {
  try {
    const date = new Date(isoDate)
    return {
      date: date.toLocaleDateString("en-US", {
        timeZone: "America/Chicago",
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      time: date.toLocaleTimeString("en-US", {
        timeZone: "America/Chicago",
        hour: "numeric",
        minute: "2-digit",
      }),
    }
  } catch {
    return { date: isoDate, time: "" }
  }
}

function renderPricePill(event: DigestEvent): string {
  const price = event.isFree
    ? "Free"
    : event.price == null
      ? ""
      : `$${Number(event.price).toFixed(2)}`
  if (!price) return ""
  const fill = event.isFree ? THEME.successSoft : THEME.peachSoft
  const color = event.isFree ? THEME.successText : THEME.peachDeep
  return `<span style="display:inline-block;background:${fill};color:${color};font-family:${FONT_MONO};font-size:11px;font-weight:500;letter-spacing:0.04em;text-transform:uppercase;padding:3px 9px;border-radius:9999px;">${escapeHtml(price)}</span>`
}

function renderEventCard(event: DigestEvent, appUrl: string): string {
  const title = stripTags(event.title)
  const location = stripTags(event.venueName || event.address || "")
  const { date, time } = splitDateTime(event.startDatetime)
  const thumbnail = firstImageUrl(event.images)
  const image = thumbnail
    ? `<img src="${escapeHtml(thumbnail)}" width="92" height="92" alt="" style="width:92px;height:92px;border-radius:12px;object-fit:cover;display:block;border:1px solid ${THEME.border};" />`
    : `<div style="width:92px;height:92px;border-radius:12px;background:${THEME.surfaceAlt};border:1px solid ${THEME.border};text-align:center;line-height:92px;font-family:${FONT_DISPLAY};font-size:34px;font-weight:600;color:${THEME.violet};">${escapeHtml((title[0] || "•").toUpperCase())}</div>`
  const explanation = event.explanation
    ? `<div style="font-family:${FONT_SANS};font-size:12px;color:${THEME.textMuted};margin-top:5px;font-style:italic;">${escapeHtml(event.explanation)}</div>`
    : ""
  const locationHtml = location
    ? `<div style="font-family:${FONT_SANS};font-size:13px;color:${THEME.blue};margin-top:6px;">&#9679;&nbsp;${escapeHtml(location)}</div>`
    : ""

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 14px;"><tr><td style="background:${THEME.surface};border:1px solid ${THEME.border};border-radius:16px;padding:16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="92" valign="top" style="padding-right:16px;">${image}</td><td valign="top"><a href="${escapeHtml(`${appUrl}/events/${event.id}`)}" style="font-family:${FONT_DISPLAY};font-size:18px;line-height:1.25;font-weight:600;color:${THEME.textPrimary};text-decoration:none;">${escapeHtml(title)}</a><div style="margin-top:8px;"><span style="font-family:${FONT_MONO};font-size:12px;color:${THEME.textMuted};">${escapeHtml(date)}${time ? ` · ${escapeHtml(time)}` : ""}</span>&nbsp;&nbsp;${renderPricePill(event)}</div>${locationHtml}${explanation}</td></tr></table></td></tr></table>`
}

export function renderDigestEmail(input: {
  user: DigestEmailUser
  events: DigestEvent[]
  appUrl: string
}): { subject: string; html: string } {
  const appUrl = input.appUrl.replace(/\/+$/, "")
  const username = escapeHtml(input.user.displayName || "there")
  const cityName = escapeHtml(input.user.cityName)
  const count = String(input.events.length)
  const eventLabel = input.events.length === 1 ? "event" : "events"
  const eventsHtml = input.events.map((event) => renderEventCard(event, appUrl)).join("\n")
  const unsubscribeUrl = `${appUrl}/profile?tab=notifications`
  const logoUrl = `${appUrl}/brand/family-events-logo.png`

  return {
    subject: `${input.events.length} family picks for your weekend`,
    html: `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="color-scheme" content="light" /><link rel="preconnect" href="https://fonts.googleapis.com" /><link href="${FONTS_HREF}" rel="stylesheet" /><style>body{margin:0;padding:0;background:${THEME.bg}}@media only screen and (max-width:600px){.fe-shell{width:100%!important;border-radius:0!important}.fe-pad{padding-left:20px!important;padding-right:20px!important}}</style></head>
<body style="margin:0;padding:0;background:${THEME.bg};font-family:${FONT_SANS};"><span style="display:none;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;">${count} family events this week in ${cityName}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:32px 12px;"><table role="presentation" class="fe-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${THEME.surface};border-radius:24px;overflow:hidden;"><tr><td class="fe-pad" style="background:${THEME.violet};background-image:linear-gradient(135deg,${THEME.violet} 0%,${THEME.violetDeep} 100%);padding:36px 40px 32px;"><img src="${escapeHtml(logoUrl)}" width="28" height="28" alt="" /><span style="font-family:${FONT_SANS};font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#F2ECFB;padding-left:10px;">Family Events</span><div style="font-family:${FONT_DISPLAY};font-size:34px;font-weight:600;color:#FFF;margin:22px 0 0;">Your Weekly Digest</div><div style="color:#FFF;margin-top:14px;">${count} ${eventLabel} this week in ${cityName}</div></td></tr><tr><td class="fe-pad" style="padding:30px 40px 6px;"><div style="font-family:${FONT_DISPLAY};font-size:21px;font-weight:600;color:${THEME.textPrimary};">Hi ${username},</div><div style="font-family:${FONT_EDITORIAL};font-size:17px;line-height:1.55;color:${THEME.textMuted};">Here are the upcoming family-friendly events near you this week — curated for your neighborhood and ready to add to the weekend plan.</div></td></tr><tr><td class="fe-pad" style="padding:22px 40px 6px;">${eventsHtml}</td></tr><tr><td align="center" class="fe-pad" style="padding:18px 40px 36px;"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:${THEME.peach};color:#FFF;font-weight:700;padding:14px 30px;border-radius:9999px;">Browse all events &rarr;</a></td></tr><tr><td class="fe-pad" style="background:${THEME.bg};padding:26px 40px;border-top:1px solid ${THEME.border};text-align:center;font-size:12px;color:${THEME.textMuted};">You're receiving this because you enabled digest emails.<br /><a href="${escapeHtml(unsubscribeUrl)}" style="color:${THEME.violetDeep};">Manage preferences</a></td></tr></table></td></tr></table></body></html>`,
  }
}
