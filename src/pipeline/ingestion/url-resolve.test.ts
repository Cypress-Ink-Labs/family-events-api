import { afterEach, describe, expect, it, vi } from "vitest"

// New coverage (upstream shipped without a url-resolve test file): pins the
// IP-literal shortcut so hostnames only skip the DNS range check when they
// really are IP literals — the upstream bare-hex match let single-label hex
// hostnames (e.g. "cafe") bypass DNS validation entirely.

vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}))

import { resolve4, resolve6 } from "node:dns/promises"
import { resolveAndCheckPublicIp } from "./url-resolve.js"

const mockResolve4 = resolve4 as unknown as ReturnType<typeof vi.fn>
const mockResolve6 = resolve6 as unknown as ReturnType<typeof vi.fn>

afterEach(() => {
  vi.clearAllMocks()
})

describe("resolveAndCheckPublicIp — IP-literal shortcut", () => {
  it("skips DNS for IPv4 literals", async () => {
    const result = await resolveAndCheckPublicIp("https://8.8.8.8/feed")
    expect(result.ok).toBe(true)
    expect(mockResolve4).not.toHaveBeenCalled()
  })

  it("skips DNS for bracketed IPv6 literals", async () => {
    const result = await resolveAndCheckPublicIp("https://[2001:db8::1]/feed")
    expect(result.ok).toBe(true)
    expect(mockResolve4).not.toHaveBeenCalled()
    expect(mockResolve6).not.toHaveBeenCalled()
  })

  it("does NOT skip DNS for single-label hex hostnames", async () => {
    // "cafe" is all hex characters — upstream's bare-hex shortcut treated it
    // as an IPv6 literal and skipped resolution. It must resolve like any
    // other hostname and be rejected when it maps to a private range.
    mockResolve4.mockResolvedValue(["10.0.0.7"])
    mockResolve6.mockRejectedValue(new Error("no AAAA"))

    const result = await resolveAndCheckPublicIp("https://cafe/feed")
    expect(mockResolve4).toHaveBeenCalledWith("cafe")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("10.0.0.7")
  })
})

describe("resolveAndCheckPublicIp — resolved-record checks", () => {
  it("accepts hostnames resolving to public IPs", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"])
    mockResolve6.mockRejectedValue(new Error("no AAAA"))

    const result = await resolveAndCheckPublicIp("https://example.com/feed")
    expect(result).toEqual({ ok: true, resolvedIps: ["93.184.216.34"] })
  })

  it("rejects hostnames resolving to link-local metadata addresses", async () => {
    mockResolve4.mockResolvedValue(["169.254.169.254"])
    mockResolve6.mockRejectedValue(new Error("no AAAA"))

    const result = await resolveAndCheckPublicIp("https://metadata.internal/latest")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("169.254.169.254")
  })

  it("rejects hostnames that do not resolve at all", async () => {
    mockResolve4.mockRejectedValue(new Error("ENOTFOUND"))
    mockResolve6.mockRejectedValue(new Error("ENOTFOUND"))

    const result = await resolveAndCheckPublicIp("https://nowhere.example/feed")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("did not resolve")
  })
})
