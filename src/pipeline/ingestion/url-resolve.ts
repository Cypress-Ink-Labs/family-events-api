// DNS-resolution-time SSRF guard. Pairs with the synchronous, IP-literal-only
// validateExternalUrl in url-validation.ts. Ported from family-events-backend
// supabase/functions/_shared/url-resolve.ts (U28); the only deviation is the
// resolver itself — Deno.resolveDns is replaced with node:dns/promises
// resolve4/resolve6.
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

import { validateExternalUrl } from "./url-validation.js"

export interface ResolveResult {
  ok: boolean
  reason?: string
  resolvedIps?: string[]
}

const PRIVATE_IPV4_REASONS: Array<{
  test: (octets: number[]) => boolean
  reason: string
}> = [
  { test: ([a = -1]) => a === 127, reason: "loopback (127.0.0.0/8)" },
  { test: ([a = -1]) => a === 10, reason: "private (10.0.0.0/8)" },
  {
    test: ([a = -1, b = -1]) => a === 172 && b >= 16 && b <= 31,
    reason: "private (172.16.0.0/12)",
  },
  { test: ([a = -1, b = -1]) => a === 192 && b === 168, reason: "private (192.168.0.0/16)" },
  {
    test: ([a = -1, b = -1]) => a === 169 && b === 254,
    reason: "link-local/metadata (169.254.0.0/16)",
  },
  { test: ([a = -1]) => a === 0, reason: "unspecified (0.0.0.0/8)" },
  { test: ([a = -1]) => a >= 224, reason: "multicast/reserved (>= 224.0.0.0)" },
]

function ipv4BlockedReason(ip: string): string | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const octets = m.slice(1).map(Number)
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null
  for (const rule of PRIVATE_IPV4_REASONS) {
    if (rule.test(octets)) return rule.reason
  }
  return null
}

function ipv6BlockedReason(ip: string): string | null {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "")
  // ::1
  if (normalized === "::1") return "IPv6 loopback (::1)"
  // ::ffff:IPv4 (IPv4-mapped) — check the embedded v4 as well
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4BlockedReason(mapped[1] ?? "")
  // fc00::/7 (unique-local)
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return "IPv6 unique-local (fc00::/7)"
  // fe80::/10 (link-local)
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return "IPv6 link-local (fe80::/10)"
  // ::/128 unspecified
  if (normalized === "::") return "IPv6 unspecified (::)"
  return null
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

  // IP literals: sync validator already checked the ranges. Deviation from
  // upstream: the IPv6 shortcut requires the brackets WHATWG URLs always put
  // around IPv6 hostnames. Upstream matched bare hex too, so a single-label
  // hex hostname (e.g. "cafe", resolvable via intranet search domains) slipped
  // past the DNS range check entirely.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) || /^\[[0-9a-fA-F:]+\]$/.test(parsed.hostname)) {
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
    const blocked = ip.includes(":") ? ipv6BlockedReason(ip) : ipv4BlockedReason(ip)
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
