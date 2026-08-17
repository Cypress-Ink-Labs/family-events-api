// DNS-resolution-time SSRF guard. Pairs with the synchronous, IP-literal-only
// validateExternalUrl in url-validation.ts. Ported from family-events-backend
// supabase/functions/_shared/url-resolve.ts (U28). Deviations:
// - Deno.resolveDns is replaced with node:dns/promises resolve4/resolve6.
// - The IPv6-literal shortcut requires the brackets WHATWG URLs always put
//   around IPv6 hostnames. Upstream matched bare hex too, so a single-label
//   hex hostname (e.g. "cafe", resolvable via intranet search domains) slipped
//   past the DNS range check entirely.
// - The regex-based range copies were deleted (PR #14 review): every resolved
//   A/AAAA record is range checked numerically via the shared ip-ranges.ts,
//   so expanded spellings like 0:0:0:0:0:0:0:1 are blocked like ::1.
//
// A user-supplied hostname (e.g. an admin-entered RSS feed URL) may resolve to
// a private/loopback/link-local IP (e.g. 169.254.169.254 for AWS IMDS, or
// 127.0.0.1 for the function's own loopback). The IP-literal check in
// url-validation.ts cannot catch this — by definition the URL contains a
// hostname, not an IP. This helper resolves the hostname before fetch and
// rejects if any returned A/AAAA record is in a blocked range.
//
// Caveat: there is still a tiny TOCTOU window between resolve and fetch. To
// fully close it you would need to fetch the resolved IP directly with the
// original Host header. For the typical SSRF threat model (a malicious admin
// or compromised feed) this DNS pre-check is sufficient defense in depth.

import { resolve4, resolve6 } from "node:dns/promises"

import { blockedIpReason } from "./ip-ranges.js"
import { validateExternalUrl } from "./url-validation.js"

export interface ResolveResult {
  ok: boolean
  reason?: string
  resolvedIps?: string[]
}

async function resolveHost(hostname: string): Promise<string[]> {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)])
  const ips: string[] = []
  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      ips.push(...r.value)
    }
  }
  return ips
}

/**
 * Validate URL synchronously, then resolve its hostname and reject if any
 * returned A/AAAA record is in a private/loopback/link-local/reserved range.
 * IP-literal URLs skip the DNS step (already covered by validateExternalUrl).
 */
export async function resolveAndCheckPublicIp(rawUrl: string): Promise<ResolveResult> {
  const syncValidation = validateExternalUrl(rawUrl)
  if (!syncValidation.ok) {
    return { ok: false, reason: syncValidation.reason }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: "Invalid URL" }
  }

  // IP literals: sync validator already checked the ranges (including the
  // dotted IPv4-mapped tail inside brackets).
  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) ||
    /^\[[0-9a-fA-F:.]+\]$/.test(parsed.hostname)
  ) {
    return { ok: true, resolvedIps: [parsed.hostname] }
  }

  let resolvedIps: string[]
  try {
    resolvedIps = await resolveHost(parsed.hostname)
  } catch (err) {
    return {
      ok: false,
      reason: `DNS resolution failed: ${err instanceof Error ? err.message : "unknown"}`,
    }
  }

  if (resolvedIps.length === 0) {
    return { ok: false, reason: "Hostname did not resolve to any IP" }
  }

  for (const ip of resolvedIps) {
    const blocked = blockedIpReason(ip)
    if (blocked) {
      return {
        ok: false,
        reason: `Hostname resolved to blocked IP ${ip} (${blocked})`,
        resolvedIps,
      }
    }
  }

  return { ok: true, resolvedIps }
}
