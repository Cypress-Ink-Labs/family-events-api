// Synchronous, IP-literal-only URL validation. Ported from family-events-backend
// supabase/functions/_shared/url-validation.ts (U28). Deviation from upstream
// (PR #14 review): the IP range rules moved to the shared ip-ranges.ts module
// so this validator and the DNS resolver can no longer drift apart, IPv4-mapped
// IPv6 literals with dotted tails (::ffff:127.0.0.1) now parse and get range
// checked instead of passing as "hostnames", and RFC 6598 / IETF internal-use
// ranges are blocked.

import {
  blockedIPv4Reason,
  blockedIPv6Reason,
  parseIPv4,
  parseIPv6,
  stripIpv6Brackets,
} from "./ip-ranges.js"

export interface UrlValidationResult {
  ok: boolean
  reason?: string
}

const BLOCKED_PROTOCOLS_MSG = "Only http and https URLs are allowed"

export function validateExternalUrl(input: unknown): UrlValidationResult {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, reason: "URL is required" }
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: "Invalid URL" }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: BLOCKED_PROTOCOLS_MSG }
  }

  const hostname = url.hostname
  if (!hostname) {
    return { ok: false, reason: "URL is missing a hostname" }
  }

  const ipv4 = parseIPv4(hostname)
  if (ipv4) {
    const blocked = blockedIPv4Reason(ipv4)
    if (blocked) return { ok: false, reason: blocked }
    return { ok: true }
  }

  const ipv6 = parseIPv6(stripIpv6Brackets(hostname))
  if (ipv6) {
    const blocked = blockedIPv6Reason(ipv6)
    if (blocked) return { ok: false, reason: blocked }
    return { ok: true }
  }

  return { ok: true }
}
