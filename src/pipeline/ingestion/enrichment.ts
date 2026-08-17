// Ingest-time image sanitization: https-only, host allowlist (source host +
// configured CDNs), guarded fetch on every hop, content-type + byte-size caps.
// Ported from family-events-backend supabase/functions/scrape-source/lib/enrichment.ts
// (U28); the only deviation is Deno.env.get → process.env.

import { validateExternalUrl } from "./url-validation.js"
import { guardedFetch, type PublicIpResolver } from "./guarded-fetch.js"
import type { ParsedEvent } from "./types.js"

const IMAGE_HEAD_TIMEOUT_MS = 5_000
const IMAGE_MAX_BYTES = 2 * 1024 * 1024
const MAX_IMAGES_PER_EVENT = 5
const IMAGE_VALIDATION_CONCURRENCY = 2
const IMAGE_VALIDATION_TIMEOUT_MS = 6_000
const IMAGE_HOST_ALLOWLIST_ENV = "SCRAPER_IMAGE_HOST_ALLOWLIST"
const LEGACY_IMAGE_HOST_ALLOWLIST_ENV = "SCRAPE_IMAGE_HOST_ALLOWLIST"

const DEFAULT_IMAGE_HOST_ALLOWLIST = [
  "images.squarespace-cdn.com",
  "cdn.prod.website-files.com",
  "static.wixstatic.com",
  "images.unsplash.com",
  "images.pexels.com",
  "pixabay.com",
]

function normalizeHost(value: string | null | undefined): string | null {
  if (!value) return null
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "") || null
  )
}

function uniqueHosts(hosts: Array<string | null | undefined>): string[] {
  const normalized = hosts
    .map((host) => normalizeHost(host))
    .filter((host): host is string => Boolean(host))
  return [...new Set(normalized)]
}

function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return normalizeHost(new URL(url).hostname)
  } catch {
    return null
  }
}

function hostAllowed(host: string, allowlist: string[]): boolean {
  const normalizedHost = normalizeHost(host)
  if (!normalizedHost) return false
  return allowlist.some(
    (allowedHost) => normalizedHost === allowedHost || normalizedHost.endsWith(`.${allowedHost}`)
  )
}

function configuredImageHostAllowlist(): string[] {
  const envValue =
    process.env[IMAGE_HOST_ALLOWLIST_ENV] ?? process.env[LEGACY_IMAGE_HOST_ALLOWLIST_ENV] ?? ""
  const configuredHosts = envValue
    .split(",")
    .map((entry) => normalizeHost(entry))
    .filter((entry): entry is string => Boolean(entry))
  return uniqueHosts([...DEFAULT_IMAGE_HOST_ALLOWLIST, ...configuredHosts])
}

async function measureImageByteLength(
  imageUrl: string,
  resolve?: PublicIpResolver
): Promise<number | null> {
  let response: Response
  try {
    response = await guardedFetch(
      imageUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": "family-events-ingester/1.0 (+https://family-events.local)",
          Accept: "image/*",
        },
        signal: AbortSignal.timeout(IMAGE_HEAD_TIMEOUT_MS),
      },
      { resolve }
    )
  } catch {
    return null
  }

  if (!response.ok || !response.body) return null

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.startsWith("image/")) return null

  const reader = response.body.getReader()
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > IMAGE_MAX_BYTES) {
        await reader.cancel()
        return total
      }
    }
  } catch {
    try {
      await reader.cancel()
    } catch {
      // best-effort cleanup
    }
    return null
  } finally {
    reader.releaseLock()
  }

  return total
}

async function validateImageAtIngest(
  imageUrl: string,
  allowedHosts: string[],
  resolve?: PublicIpResolver
): Promise<string | null> {
  const externalUrlValidation = validateExternalUrl(imageUrl)
  if (!externalUrlValidation.ok) return null

  let parsedUrl: URL
  try {
    parsedUrl = new URL(imageUrl)
  } catch {
    return null
  }

  if (parsedUrl.protocol !== "https:") return null
  if (!hostAllowed(parsedUrl.hostname, allowedHosts)) return null

  let response: Response
  try {
    response = await guardedFetch(
      parsedUrl.toString(),
      {
        method: "HEAD",
        headers: {
          "User-Agent": "family-events-ingester/1.0 (+https://family-events.local)",
          Accept: "image/*",
        },
        signal: AbortSignal.timeout(IMAGE_HEAD_TIMEOUT_MS),
      },
      { resolve }
    )
  } catch {
    return null
  }

  if (!response.ok) return null

  const responseUrl = response.url || parsedUrl.toString()
  const finalHost = hostFromUrl(responseUrl)
  if (!finalHost || !hostAllowed(finalHost, allowedHosts)) return null

  let finalUrl: URL
  try {
    finalUrl = new URL(responseUrl)
  } catch {
    return null
  }
  if (finalUrl.protocol !== "https:") return null

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.startsWith("image/")) return null

  const contentLengthHeader = response.headers.get("content-length")
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null
  const measuredLength = contentLengthHeader
    ? null
    : await measureImageByteLength(finalUrl.toString(), resolve)
  const effectiveLength = contentLength ?? measuredLength
  if (
    effectiveLength === null ||
    !Number.isFinite(effectiveLength) ||
    effectiveLength <= 0 ||
    effectiveLength > IMAGE_MAX_BYTES
  ) {
    return null
  }

  return finalUrl.toString()
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => resolve(null), timeoutMs)
    promise
      .then((value) => resolve(value))
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timeoutId))
  })
}

export async function sanitizeImagesForIngest(
  parsed: ParsedEvent,
  sourceUrl: string,
  deps?: { resolve?: PublicIpResolver }
): Promise<string[]> {
  const sourceHost = hostFromUrl(sourceUrl)
  const allowedHosts = uniqueHosts([sourceHost, ...configuredImageHostAllowlist()])
  if (allowedHosts.length === 0) return []

  const imageCandidates = [
    ...new Set([...parsed.images, ...(parsed.imageUrl ? [parsed.imageUrl] : [])]),
  ]

  const validImages: string[] = []
  let cursor = 0

  while (cursor < imageCandidates.length && validImages.length < MAX_IMAGES_PER_EVENT) {
    const batch = imageCandidates.slice(cursor, cursor + IMAGE_VALIDATION_CONCURRENCY)
    cursor += batch.length

    const results = await Promise.all(
      batch.map((imageCandidate) =>
        withTimeout(
          validateImageAtIngest(imageCandidate, allowedHosts, deps?.resolve),
          IMAGE_VALIDATION_TIMEOUT_MS
        )
      )
    )

    for (const validatedImage of results) {
      if (!validatedImage || validImages.includes(validatedImage)) continue
      validImages.push(validatedImage)
      if (validImages.length >= MAX_IMAGES_PER_EVENT) break
    }
  }

  return validImages
}
