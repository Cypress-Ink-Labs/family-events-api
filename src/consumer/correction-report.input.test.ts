import { describe, expect, it } from "vitest"

import {
  capabilityHash,
  contentDigest,
  newAnonymousCapability,
  parseCorrectionReport,
} from "./correction-report.input.js"

describe("correction report input and anonymous privacy controls", () => {
  it("bounds private material and rejects undeclared fields", () => {
    expect(() =>
      parseCorrectionReport({
        category: "other",
        details: "wrong",
        contact: { email: `${"x".repeat(321)}@example.com` },
      })
    ).toThrow()
    expect(() =>
      parseCorrectionReport({ category: "other", details: "wrong", fingerprint: "device" })
    ).toThrow()
  })

  it("creates random capabilities and stores only purpose-bound hashes", () => {
    const first = newAnonymousCapability()
    const second = newAnonymousCapability()
    expect(first).not.toBe(second)
    expect(capabilityHash(first)).toHaveLength(32)
    expect(capabilityHash(first).toString("hex")).not.toContain(first)
  })

  it("deduplicates on bounded public report content, never private contact or evidence", () => {
    const base = { category: "cancellation" as const, details: "Organizer says cancelled" }
    expect(
      contentDigest("4dc17888-65c6-4a78-ab4a-3270bcad8438", {
        ...base,
        contact: { email: "one@example.com" },
        evidence_urls: ["https://example.com/private-one"],
      })
    ).toEqual(
      contentDigest("4dc17888-65c6-4a78-ab4a-3270bcad8438", {
        ...base,
        contact: { phone: "+1 555 555 1212" },
        evidence_urls: ["https://example.com/private-two"],
      })
    )
  })

  it("canonicalizes event UUID casing and Unicode details before digesting", () => {
    const input = { category: "other" as const, details: "Cafe\u0301 time" }
    expect(contentDigest("4DC17888-65C6-4A78-AB4A-3270BCAD8438", input)).toEqual(
      contentDigest("4dc17888-65c6-4a78-ab4a-3270bcad8438", {
        ...input,
        details: "Café time",
      })
    )
  })

  it("accepts only bounded HTTP evidence URLs and valid private contact", () => {
    expect(() =>
      parseCorrectionReport({
        category: "other",
        details: "wrong",
        evidence_urls: ["file:///etc/passwd"],
      })
    ).toThrow()
    expect(
      parseCorrectionReport({
        category: "other",
        details: "wrong",
        contact: { email: "parent@example.com", phone: "+1 (555) 555-1212" },
        evidence_urls: ["https://example.com/proof"],
      })
    ).toBeDefined()
  })
})
