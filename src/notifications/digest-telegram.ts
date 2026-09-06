import { type DigestEmailUser, type DigestEvent, escapeHtml } from "./digest-html.js"

const MESSAGE_LIMIT = 4096

function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function escapedText(value: string, limit: number): string {
  const escaped = escapeHtml(value)
  if (escaped.length <= limit) return escaped
  let result = ""
  // Truncate before escaping so neither entities nor surrogate pairs are split.
  for (const character of value) {
    const part = escapeHtml(character)
    if (result.length + part.length > limit - 1) break
    result += part
  }
  return `${result}…`
}

function link(url: string, label: string): string {
  const href = escapeHtml(url)
  // A malformed or oversized configured URL must not consume the message budget.
  return href.length <= 512 && /^https?:\/\//i.test(url) ? `<a href="${href}">${label}</a>` : label
}

function eventBlock(event: DigestEvent, appUrl: string): string {
  const date = new Date(event.startDatetime)
  const dateLabel = Number.isNaN(date.getTime())
    ? event.startDatetime
    : date.toLocaleDateString("en-US", {
        timeZone: "America/Chicago",
        weekday: "short",
        month: "short",
        day: "numeric",
      })
  const price = event.isFree
    ? "Free"
    : event.price == null
      ? ""
      : `$${Number(event.price).toFixed(2)}`
  const metadata = [dateLabel, stripTags(event.venueName || event.address || ""), price]
    .filter(Boolean)
    .map((part) => escapedText(part, 240))
    .join(" · ")
  const lines = [
    `• ${link(`${appUrl}/events/${encodeURIComponent(event.id)}`, escapedText(stripTags(event.title), 240))}`,
    `  ${metadata}`,
  ]
  if (event.explanation) lines.push(`  <i>${escapedText(event.explanation, 240)}</i>`)
  return lines.join("\n")
}

export function renderDigestTelegram(input: {
  user: DigestEmailUser
  events: DigestEvent[]
  appUrl: string
}): string {
  const appUrl = input.appUrl.replace(/\/+$/, "")
  const header = `<b>Hi ${escapedText(input.user.displayName || "there", 100)}, your weekend in ${escapedText(input.user.cityName, 100)}!</b>`
  const footer = `\n\n${link(appUrl, "→ Browse all events")}`
  let message = `${header}\n`
  for (const event of input.events) {
    const block = `\n${eventBlock(event, appUrl)}`
    // Keep complete event blocks and reserve the footer, including markup.
    if (message.length + block.length + footer.length > MESSAGE_LIMIT) break
    message += block
  }
  return message + footer
}
