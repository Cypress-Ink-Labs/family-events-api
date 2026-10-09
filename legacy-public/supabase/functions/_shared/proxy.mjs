const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BYTES = 8 * 1024 * 1024
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}
const FILTERS = {
  "events-api": [
    "city_id",
    "date_from",
    "date_to",
    "is_free",
    "tags",
    "keyword",
    "limit",
    "cursor",
  ],
  "events-feed": ["format", "city"],
  "share-og": ["eventId", "event_id"],
  sitemap: ["type"],
}
const RESPONSE_HEADERS = [
  "Content-Type",
  "Cache-Control",
  "Content-Disposition",
  "ETag",
  "Last-Modified",
  "Expires",
]
const PUBLIC_TYPES = new Set([
  "application/json",
  "application/rss+xml",
  "application/xml",
  "text/xml",
  "text/calendar",
  "text/plain",
])

function configuredOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null
  try {
    const url = new URL(value)
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null
    return url.origin
  } catch {
    return null
  }
}

function errorResponse(status, error) {
  return Response.json(
    { error },
    {
      status,
      headers: {
        ...CORS,
        "Cache-Control": "no-store",
        ...(status === 405 ? { Allow: "GET, OPTIONS" } : {}),
      },
    }
  )
}

function destination(name, url, origin) {
  const match = new RegExp(`^/(?:functions/v1/)?${name}(?:/([^/]*))?/?$`).exec(url.pathname)
  if (!match) return null
  let suffix
  try {
    suffix = decodeURIComponent(match[1] ?? "")
  } catch {
    return null
  }
  let path
  switch (name) {
    case "events-api":
      if (suffix && !UUID.test(suffix)) return null
      path = `/api/events${suffix ? `/${suffix}` : ""}`
      break
    case "events-feed":
      if (suffix) return null
      path = "/feeds/events"
      break
    case "share-og":
      if (suffix && !UUID.test(suffix)) return null
      path = `/functions/v1/share-og${suffix ? `/${suffix}` : ""}`
      break
    case "sitemap":
      if (suffix && !["sitemap.xml", "robots.txt"].includes(suffix)) return null
      path =
        suffix === "robots.txt" || url.searchParams.get("type") === "robots"
          ? "/robots.txt"
          : "/sitemap.xml"
      break
    default:
      return null
  }
  const target = new URL(path, origin)
  for (const [key, value] of url.searchParams) {
    if (FILTERS[name].includes(key)) target.searchParams.append(key, value)
  }
  return target
}

async function publicBody(response) {
  if (Number(response.headers.get("Content-Length")) > MAX_BYTES)
    throw new Error("response too large")
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) throw new Error("response too large")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * @param {string} name
 * @param {{ origin?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function createLegacyPublicHandler(
  name,
  { origin, fetchImpl = fetch, timeoutMs = 10_000 } = {}
) {
  const publicOrigin = configuredOrigin(origin)
  return async (request) => {
    if (!publicOrigin || !Object.hasOwn(FILTERS, name))
      return errorResponse(503, "service unavailable")
    if (!["GET", "OPTIONS"].includes(request.method))
      return errorResponse(405, "method not allowed")
    const target = destination(name, new URL(request.url), publicOrigin)
    if (!target) return errorResponse(404, "not found")
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS })
    if (name === "share-og" || (name === "sitemap" && target.pathname === "/sitemap.xml")) {
      return new Response(null, {
        status: 307,
        headers: { ...CORS, Location: target.href, "Cache-Control": "no-store" },
      })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(target, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept:
            "application/json, application/rss+xml, application/xml, text/calendar, text/plain",
        },
      })
      if (![200, 400, 404].includes(response.status)) throw new Error("unexpected upstream status")
      const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase()
      if (!type || !PUBLIC_TYPES.has(type)) throw new Error("unexpected upstream content type")
      const body = await publicBody(response)
      const headers = new Headers(CORS)
      for (const key of RESPONSE_HEADERS) {
        const value = response.headers.get(key)
        if (value !== null) headers.set(key, value)
      }
      if (response.status !== 200) headers.set("Cache-Control", "no-store")
      return new Response(body, { status: response.status, headers })
    } catch {
      controller.abort()
      return errorResponse(503, "service unavailable")
    } finally {
      clearTimeout(timer)
    }
  }
}
