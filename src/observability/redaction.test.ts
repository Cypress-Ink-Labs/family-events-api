import { describe, expect, it } from "vitest"

import { redact } from "./redaction.js"

describe("redact", () => {
  it("recursively removes sensitive keys and values", () => {
    const secret = "known-value"
    expect(
      redact(
        {
          authorization: "Bearer token",
          nested: {
            password: "password",
            invite: { code: "once" },
            harmless: `prefix ${secret}`,
            url: "postgresql://user:pass@db.example/test",
            error: "failed for ABCDEFGHJKLMNPQRSTUV2345",
          },
          emailPayload: { subject: "private" },
        },
        { sensitiveValues: [secret] }
      )
    ).toEqual({
      authorization: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        invite: { code: "[REDACTED]" },
        harmless: "[REDACTED]",
        url: "[REDACTED]",
        error: "[REDACTED]",
      },
      emailPayload: "[REDACTED]",
    })
  })

  it("bounds cycles, depth, arrays, objects, and strings", () => {
    const cyclic: Record<string, unknown> = { long: "abcdef", array: [1, 2, 3] }
    cyclic.self = cyclic
    const result = redact(cyclic, {
      maxDepth: 2,
      maxArrayLength: 2,
      maxObjectKeys: 3,
      maxStringLength: 3,
    })
    expect(result).toEqual({
      long: "abc[TRUNCATED]",
      array: [1, 2, "[TRUNCATED]"],
      self: "[CIRCULAR]",
    })
  })
})
