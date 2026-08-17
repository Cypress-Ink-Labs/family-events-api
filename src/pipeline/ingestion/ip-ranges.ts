// Single source of truth for the SSRF IP blocklist. Extracted from the
// duplicated range rules in url-validation.ts (numeric checks) and
// url-resolve.ts (regex checks) per PR #14 review: the two copies had already
// diverged, and the DNS path silently kept the weaker text-matching rules
// (an expanded "0:0:0:0:0:0:0:1" slipped past the "::1" literal match).
// Both callers now share these numeric checks. Beyond the upstream ranges,
// RFC 6598 shared space (100.64.0.0/10 — cloud node/pod networks) and the
// IETF internal-use ranges 192.0.0.0/24 and 198.18.0.0/15 are blocked too.

export function parseIPv4(host: string): [number, number, number, number] | null {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return null
  const octets: [number, number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ]
  for (const o of octets) {
    if (!Number.isInteger(o) || o < 0 || o > 255) return null
  }
  return octets
}

export function blockedIPv4Reason(octets: [number, number, number, number]): string | null {
  const [a, b, c] = octets
  if (a === 127) return "Blocked IPv4 range 127.0.0.0/8 (loopback)"
  if (a === 10) return "Blocked IPv4 range 10.0.0.0/8 (private)"
  if (a === 172 && b >= 16 && b <= 31) return "Blocked IPv4 range 172.16.0.0/12 (private)"
  if (a === 192 && b === 168) return "Blocked IPv4 range 192.168.0.0/16 (private)"
  if (a === 169 && b === 254) return "Blocked IPv4 range 169.254.0.0/16 (link-local/metadata)"
  if (a === 100 && b >= 64 && b <= 127) return "Blocked IPv4 range 100.64.0.0/10 (shared/CGNAT)"
  if (a === 192 && b === 0 && c === 0) {
    return "Blocked IPv4 range 192.0.0.0/24 (IETF protocol assignments)"
  }
  if (a === 198 && (b === 18 || b === 19)) return "Blocked IPv4 range 198.18.0.0/15 (benchmarking)"
  if (a === 0) return "Blocked IPv4 range 0.0.0.0/8 (unspecified)"
  if (a >= 224) return "Blocked IPv4 range >= 224.0.0.0 (multicast/reserved)"
  return null
}

export function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1)
  return host
}

/**
 * Parse an IPv6 address (optionally with an embedded IPv4 tail such as
 * ::ffff:127.0.0.1) into its 8 16-bit groups. Returns null when the text is
 * not a valid IPv6 address.
 */
export function parseIPv6(host: string): number[] | null {
  if (!host.includes(":")) return null

  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) → convert to two hex groups.
  let normalized = host
  const v4Tail = host.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4Tail) {
    const octets = parseIPv4(v4Tail[2] ?? "")
    if (!octets) return null
    const [a, b, c, d] = octets
    normalized = `${v4Tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  if (!/^[0-9a-fA-F:]+$/.test(normalized)) return null

  const parts = normalized.split("::")
  if (parts.length > 2) return null

  const leftRaw = parts[0] ?? ""
  const rightRaw = (parts.length === 2 ? parts[1] : "") ?? ""
  const left = leftRaw.length > 0 ? leftRaw.split(":") : []
  const right = rightRaw.length > 0 ? rightRaw.split(":") : []

  if (parts.length === 1) {
    if (left.length !== 8) return null
    return toGroups(left)
  }

  const missing = 8 - left.length - right.length
  if (missing < 1) return null
  const all = [...left, ...Array(missing).fill("0"), ...right]
  return toGroups(all)
}

function toGroups(parts: string[]): number[] | null {
  const out: number[] = []
  for (const p of parts) {
    if (p.length === 0 || p.length > 4) return null
    if (!/^[0-9a-fA-F]+$/.test(p)) return null
    out.push(parseInt(p, 16))
  }
  return out.length === 8 ? out : null
}

export function blockedIPv6Reason(groups: number[]): string | null {
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return "Blocked IPv6 address ::1 (loopback)"
  }
  const first = groups[0] ?? 0
  const firstByte = first >> 8
  if (firstByte === 0xfc || firstByte === 0xfd) {
    if (firstByte === 0xfd) return "Blocked IPv6 range fd00::/8 (unique-local)"
    return "Blocked IPv6 range fc00::/7 (unique-local)"
  }
  if ((first & 0xffc0) === 0xfe80) {
    return "Blocked IPv6 range fe80::/10 (link-local)"
  }
  if (groups.every((g) => g === 0)) {
    return "Blocked IPv6 address :: (unspecified)"
  }
  // ::ffff:a.b.c.d (IPv4-mapped) — re-check the embedded IPv4 against v4 ranges
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const g6 = groups[6] ?? 0
    const g7 = groups[7] ?? 0
    const embedded = blockedIPv4Reason([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff])
    if (embedded) return `Blocked IPv4-mapped IPv6 (${embedded})`
  }
  return null
}

/**
 * Range-check one resolved A/AAAA record (or IP literal) in text form.
 * Numeric parsing (not text matching) so expanded/alternate spellings of the
 * same address are still caught. Unparseable input is not blocked here — the
 * callers reject unresolvable hosts separately.
 */
export function blockedIpReason(ip: string): string | null {
  const bare = stripIpv6Brackets(ip.trim())
  const v4 = parseIPv4(bare)
  if (v4) return blockedIPv4Reason(v4)
  const v6 = parseIPv6(bare)
  if (v6) return blockedIPv6Reason(v6)
  return null
}
