import { describe, expect, it } from "vitest"

import { validateExternalUrl } from "./url-validation.js"

// Ported verbatim from family-events-backend _shared/url-validation.test.ts (U28).

describe("validateExternalUrl — input shape", () => {
  it("rejects non-string / empty input", () => {
    expect(validateExternalUrl(undefined).ok).toBe(false)
    expect(validateExternalUrl(null).ok).toBe(false)
    expect(validateExternalUrl("").ok).toBe(false)
    expect(validateExternalUrl(42 as unknown as string).ok).toBe(false)
  })

  it("rejects an unparseable URL string", () => {
    expect(validateExternalUrl("not a url").ok).toBe(false)
    expect(validateExternalUrl("http://").ok).toBe(false)
  })
})

describe("validateExternalUrl — protocol", () => {
  it.each([
    ["file:///etc/passwd"],
    ["ftp://example.com/"],
    ["gopher://example.com/"],
    ["javascript:alert(1)"],
    ["data:text/plain,hi"],
  ])("rejects non-http(s) scheme %s", (url) => {
    const res = validateExternalUrl(url)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/http/i)
  })

  it("accepts http", () => {
    expect(validateExternalUrl("http://example.com/path").ok).toBe(true)
  })

  it("accepts https", () => {
    expect(validateExternalUrl("https://example.com/path?q=1").ok).toBe(true)
  })
})

describe("validateExternalUrl — IPv4 blocked ranges", () => {
  it("rejects 127.0.0.0/8 loopback", () => {
    const res = validateExternalUrl("http://127.0.0.1/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("127.0.0.0/8")
  })

  it("rejects 10.0.0.0/8 private", () => {
    const res = validateExternalUrl("http://10.1.2.3/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("10.0.0.0/8")
  })

  it("rejects 172.16.0.0/12 private (low edge)", () => {
    const res = validateExternalUrl("http://172.16.0.1/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("172.16.0.0/12")
  })

  it("rejects 172.16.0.0/12 private (high edge 172.31.x.x)", () => {
    const res = validateExternalUrl("http://172.31.255.254/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("172.16.0.0/12")
  })

  it("rejects 192.168.0.0/16 private", () => {
    const res = validateExternalUrl("https://192.168.1.1/admin")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("192.168.0.0/16")
  })

  it("rejects 169.254.0.0/16 link-local (AWS metadata)", () => {
    const res = validateExternalUrl("http://169.254.169.254/latest/meta-data/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("169.254.0.0/16")
  })

  it("allows public IPv4 addresses", () => {
    expect(validateExternalUrl("https://8.8.8.8/").ok).toBe(true)
    expect(validateExternalUrl("http://1.1.1.1/").ok).toBe(true)
  })

  it("allows IPv4 just outside the 172.16/12 range", () => {
    expect(validateExternalUrl("http://172.15.0.1/").ok).toBe(true)
    expect(validateExternalUrl("http://172.32.0.1/").ok).toBe(true)
  })

  it("allows IPv4 just outside the 192.168/16 range", () => {
    expect(validateExternalUrl("http://192.167.1.1/").ok).toBe(true)
    expect(validateExternalUrl("http://192.169.1.1/").ok).toBe(true)
  })

  it("allows 169.253.x.x (outside 169.254/16)", () => {
    expect(validateExternalUrl("http://169.253.1.1/").ok).toBe(true)
  })

  it("normalizes integer/hex IPv4 via WHATWG URL and still blocks loopback", () => {
    // new URL("http://2130706433/") → hostname "127.0.0.1"
    expect(validateExternalUrl("http://2130706433/").ok).toBe(false)
    expect(validateExternalUrl("http://0x7f000001/").ok).toBe(false)
  })

  it("rejects RFC 6598 shared space and IETF internal-use ranges", () => {
    const cgnat = validateExternalUrl("http://100.100.100.200/")
    expect(cgnat.ok).toBe(false)
    expect(cgnat.reason).toContain("100.64.0.0/10")
    expect(validateExternalUrl("http://192.0.0.10/").ok).toBe(false)
    expect(validateExternalUrl("http://198.18.0.1/").ok).toBe(false)
    expect(validateExternalUrl("http://198.19.255.254/").ok).toBe(false)
    // Neighbouring public space stays allowed.
    expect(validateExternalUrl("http://100.63.255.254/").ok).toBe(true)
    expect(validateExternalUrl("http://100.128.0.1/").ok).toBe(true)
    expect(validateExternalUrl("http://198.17.0.1/").ok).toBe(true)
    expect(validateExternalUrl("http://198.20.0.1/").ok).toBe(true)
    expect(validateExternalUrl("http://192.0.1.1/").ok).toBe(true)
  })
})

describe("validateExternalUrl — IPv6 blocked ranges", () => {
  it("rejects ::1 loopback", () => {
    const res = validateExternalUrl("http://[::1]/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("::1")
  })

  it("rejects fc00::/7 unique-local (0xfc prefix)", () => {
    const res = validateExternalUrl("http://[fc00::1]/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("fc00::/7")
  })

  it("rejects fd00::/8 unique-local (0xfd prefix)", () => {
    const res = validateExternalUrl("http://[fd12:3456:789a::1]/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("fd00::/8")
  })

  it("rejects fe80::/10 link-local", () => {
    const res = validateExternalUrl("http://[fe80::1]/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("fe80::/10")
  })

  it("rejects fe80::/10 link-local at the high end (febf)", () => {
    const res = validateExternalUrl("http://[febf::1]/")
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("fe80::/10")
  })

  it("allows public IPv6 addresses", () => {
    expect(validateExternalUrl("http://[2001:db8::1]/").ok).toBe(true)
    expect(validateExternalUrl("https://[2606:4700:4700::1111]/").ok).toBe(true)
  })

  it("allows IPv6 just outside fe80::/10 (fec0::)", () => {
    expect(validateExternalUrl("http://[fec0::1]/").ok).toBe(true)
  })

  it("allows IPv6 just outside fc00::/7 (fb00::)", () => {
    expect(validateExternalUrl("http://[fb00::1]/").ok).toBe(true)
  })

  it("range-checks dotted IPv4-mapped IPv6 literals instead of passing them as hostnames", () => {
    const mappedLoopback = validateExternalUrl("http://[::ffff:127.0.0.1]/")
    expect(mappedLoopback.ok).toBe(false)
    expect(mappedLoopback.reason).toContain("IPv4-mapped")
    expect(validateExternalUrl("http://[::ffff:8.8.8.8]/").ok).toBe(true)
  })
})

describe("validateExternalUrl — hostnames", () => {
  it("allows normal domain hostnames", () => {
    expect(validateExternalUrl("https://example.com/").ok).toBe(true)
    expect(validateExternalUrl("https://sub.example.co.uk/path?a=1").ok).toBe(true)
  })

  it("does not attempt DNS resolution (hostnames that LOOK private by name are allowed)", () => {
    // e.g. a domain named "localhost.example.com" is fine — DNS rebinding is
    // a separate concern outside this validator's scope.
    expect(validateExternalUrl("https://localhost.example.com/").ok).toBe(true)
  })
})
