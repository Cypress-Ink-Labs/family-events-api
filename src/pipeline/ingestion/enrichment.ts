// Ingest-time image sanitization: https-only, host allowlist (source host +
// configured CDNs), guarded fetch on every hop, content-type + byte-size caps.
// Ported from family-events-backend supabase/functions/scrape-source/lib/enrichment.ts
// (U28). Deviations (PR #14 review, beyond Deno.env.get → process.env):
// - candidates are capped at MAX_IMAGE_CANDIDATES before validation so a page
//   listing hundreds of broken image URLs cannot stall the worker,
// - the per-candidate timeout aborts the in-flight request instead of
//   abandoning it, and
// - validateImageAtIngest is decomposed into named policy gates.

import { validateExternalUrl } from "./url-validation.js"
import { guardedFetch, type PublicIpResolver } from "./guarded-fetch.js"
import type { ParsedEvent } from "./types.js"

const IMAGE_HEAD_TIMEOUT_MS = 5_000
const IMAGE_MAX_BYTES = 2 * 1024 * 1024
const MAX_IMAGES_PER_EVENT = 5
const MAX_IMAGE_CANDIDATES = 20
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

function requestSignal(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return outer ? AbortSignal.any([outer, timeout]) : timeout
}

async function measureImageByteLength(
  imageUrl: string,
  resolve?: PublicIpResolver,
  signal?: AbortSignal
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
        signal: requestSignal(IMAGE_HEAD_TIMEOUT_MS, signal),
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

/** Gate 1: URL shape policy — parseable, https-only, allowlisted host. */
function checkImageUrlPolicy(imageUrl: string, allowedHosts: string[]): URL | null {
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
  return parsedUrl
}

/** Gate 3: the post-redirect response must still satisfy the URL policy. */
function checkFinalUrlPolicy(
  response: Response,
  parsedUrl: URL,
  allowedHosts: string[]
): URL | null {
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
  return finalUrl
}

/** Gate 4: size from content-length, or a capped streaming read without one. */
async function resolveImageByteLength(
  response: Response,
  finalUrl: URL,
  resolve?: PublicIpResolver,
  signal?: AbortSignal
): Promise<number | null> {
  const contentLengthHeader = response.headers.get("content-length")
  if (contentLengthHeader) return Number(contentLengthHeader)
  return measureImageByteLength(finalUrl.toString(), resolve, signal)
}

async function validateImageAtIngest(
  imageUrl: string,
  allowedHosts: string[],
  resolve?: PublicIpResolver,
  signal?: AbortSignal
): Promise<string | null> {
  const parsedUrl = checkImageUrlPolicy(imageUrl, allowedHosts)
  if (!parsedUrl) return null

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
        signal: requestSignal(IMAGE_HEAD_TIMEOUT_MS, signal),
      },
      { resolve }
    )
  } catch {
    return null
  }

  if (!response.ok) return null

  const finalUrl = checkFinalUrlPolicy(response, parsedUrl, allowedHosts)
  if (!finalUrl) return null

  const effectiveLength = await resolveImageByteLength(response, finalUrl, resolve, signal)
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

function withTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  const controller = new AbortController()
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, timeoutMs)
    start(controller.signal)
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
  ].slice(0, MAX_IMAGE_CANDIDATES)

  const validImages: string[] = []
  let cursor = 0

  while (cursor < imageCandidates.length && validImages.length < MAX_IMAGES_PER_EVENT) {
    const batch = imageCandidates.slice(cursor, cursor + IMAGE_VALIDATION_CONCURRENCY)
    cursor += batch.length

    const results = await Promise.all(
      batch.map((imageCandidate) =>
        withTimeout(
          (signal) => validateImageAtIngest(imageCandidate, allowedHosts, deps?.resolve, signal),
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
