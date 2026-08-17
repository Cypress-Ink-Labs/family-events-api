import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { guardedFetch, SsrfRejectedError } from "./guarded-fetch.js"

// Ported verbatim from family-events-backend _shared/guarded-fetch.test.ts (U28).
// Mock url-resolve so tests don't need real DNS.
vi.mock("./url-resolve.js", () => ({
  resolveAndCheckPublicIp: vi.fn(),
}))

import { resolveAndCheckPublicIp } from "./url-resolve.js"

const mockResolve = resolveAndCheckPublicIp as ReturnType<typeof vi.fn>

function makeRedirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  })
}

function makeOkResponse(body = "ok"): Response {
  return new Response(body, { status: 200 })
}

describe("guardedFetch — SSRF rejection on initial URL", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("throws SsrfRejectedError when URL resolves to a private IP", async () => {
    mockResolve.mockResolvedValue({
      ok: false,
      reason: "Hostname resolved to blocked IP 10.0.0.1 (private (10.0.0.0/8))",
    })

    const err = await guardedFetch("https://internal.example.com/api").catch((e) => e)
    expect(err).toBeInstanceOf(SsrfRejectedError)
    expect(err.message).toMatch(/URL rejected by SSRF guard/)
  })

  it("returns the response when the URL resolves to a public IP", async () => {
    mockResolve.mockResolvedValue({ ok: true, resolvedIps: ["93.184.216.34"] })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeOkResponse("hello")))

    const res = await guardedFetch("https://example.com/data")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("hello")
  })
})

describe("guardedFetch — redirect re-validation", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("follows a 302 to a public Location and returns the final response", async () => {
    // First hop: public → ok; second hop: public → ok.
    mockResolve
      .mockResolvedValueOnce({ ok: true, resolvedIps: ["93.184.216.34"] })
      .mockResolvedValueOnce({ ok: true, resolvedIps: ["93.184.216.34"] })

    const finalResponse = makeOkResponse("final")
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeRedirectResponse("https://example.com/final"))
        .mockResolvedValueOnce(finalResponse)
    )

    const res = await guardedFetch("https://example.com/start")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("final")
  })

  it("throws SsrfRejectedError when a 302 Location resolves to a private IP", async () => {
    // First hop: public URL passes; second hop: Location header resolves to private.
    mockResolve
      .mockResolvedValueOnce({ ok: true, resolvedIps: ["93.184.216.34"] })
      .mockResolvedValueOnce({
        ok: false,
        reason:
          "Hostname resolved to blocked IP 169.254.169.254 (link-local/metadata (169.254.0.0/16))",
      })

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(makeRedirectResponse("https://metadata.internal/latest/"))
    )

    const err = await guardedFetch("https://example.com/start").catch((e) => e)
    expect(err).toBeInstanceOf(SsrfRejectedError)
    expect(err.message).toMatch(/URL rejected by SSRF guard/)
  })

  it("throws SsrfRejectedError after exhausting maxRedirects hops", async () => {
    // Every hop is public — just too many redirects.
    mockResolve.mockResolvedValue({ ok: true, resolvedIps: ["93.184.216.34"] })
    // Always returns a redirect to itself.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeRedirectResponse("https://example.com/loop"))
    )

    // Default maxRedirects = 3; after 3+1 hops we should exhaust.
    await expect(guardedFetch("https://example.com/loop")).rejects.toThrow(SsrfRejectedError)
    await expect(guardedFetch("https://example.com/loop")).rejects.toThrow(/too many redirects/)
  })

  it("strips credential headers when a redirect crosses origins", async () => {
    mockResolve.mockResolvedValue({ ok: true, resolvedIps: ["93.184.216.34"] })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectResponse("https://other.example.net/target"))
      .mockResolvedValueOnce(makeOkResponse("done"))
    vi.stubGlobal("fetch", fetchMock)

    await guardedFetch("https://example.com/start", {
      headers: { Authorization: "Bearer secret", Cookie: "sid=1", Accept: "text/html" },
    })

    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    const headers = new Headers(secondInit.headers)
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("accept")).toBe("text/html")
  })

  it("keeps headers on same-origin redirects", async () => {
    mockResolve.mockResolvedValue({ ok: true, resolvedIps: ["93.184.216.34"] })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectResponse("https://example.com/next"))
      .mockResolvedValueOnce(makeOkResponse("done"))
    vi.stubGlobal("fetch", fetchMock)

    await guardedFetch("https://example.com/start", {
      headers: { Authorization: "Bearer secret" },
    })

    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(new Headers(secondInit.headers).get("authorization")).toBe("Bearer secret")
  })

  it("rewrites 302 POST to a bodyless GET on the next hop (RFC 9110)", async () => {
    mockResolve.mockResolvedValue({ ok: true, resolvedIps: ["93.184.216.34"] })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectResponse("https://example.com/next"))
      .mockResolvedValueOnce(makeOkResponse("done"))
    vi.stubGlobal("fetch", fetchMock)

    await guardedFetch("https://example.com/start", { method: "POST", body: "payload" })

    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(secondInit.method).toBe("GET")
    expect("body" in secondInit && secondInit.body !== undefined).toBe(false)
  })
})
