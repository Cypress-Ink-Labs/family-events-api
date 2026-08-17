// SSRF-safe fetch. Wraps resolveAndCheckPublicIp and — critically — disables
// transparent redirect following so a public host cannot 30x-redirect into a
// private/loopback/metadata target that was never validated. Ported verbatim
// from family-events-backend supabase/functions/_shared/guarded-fetch.ts (U28).
//
// Plain `fetch(url)` defaults to redirect: "follow", which means the original
// URL can pass resolveAndCheckPublicIp and then be redirected to
// http://169.254.169.254/ (cloud metadata) or 127.0.0.1 with no second check.
// This helper validates every hop: it resolves + range-checks the URL, fetches
// with redirect: "manual", and on a 3xx re-validates the Location target before
// following it, up to a bounded depth.

import { resolveAndCheckPublicIp } from "./url-resolve.js"

/** SSRF resolver/range-check seam. Defaults to {@link resolveAndCheckPublicIp}. */
export type PublicIpResolver = (url: string) => Promise<{ ok: boolean; reason?: string }>

export interface GuardedFetchOptions {
  /** Max redirect hops to follow (each re-validated). Default 3. */
  maxRedirects?: number
  /**
   * Resolver used to range-check every hop. Defaults to the real DNS-backed
   * {@link resolveAndCheckPublicIp}; injectable so unit tests can validate the
   * fetch/redirect logic without real DNS.
   */
  resolve?: PublicIpResolver
}

export class SsrfRejectedError extends Error {
  constructor(reason: string) {
    super(`URL rejected by SSRF guard: ${reason}`)
    this.name = "SsrfRejectedError"
  }
}

/**
 * Fetch a URL with SSRF protection on every redirect hop.
 *
 * Throws SsrfRejectedError if the URL (or any redirect target) resolves to a
 * private/loopback/link-local/reserved IP. The caller's `init.redirect` is
 * ignored — redirects are handled here.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: GuardedFetchOptions = {}
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3
  const resolve = opts.resolve ?? resolveAndCheckPublicIp
  let currentUrl = rawUrl

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await resolve(currentUrl)
    if (!check.ok) {
      throw new SsrfRejectedError(check.reason ?? "unknown reason")
    }

    const response = await fetch(currentUrl, { ...init, redirect: "manual" })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) return response
      // Release the redirect response body before following the next hop.
      await response.body?.cancel().catch(() => {})
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }

    return response
  }

  throw new SsrfRejectedError(`too many redirects (> ${maxRedirects})`)
}
