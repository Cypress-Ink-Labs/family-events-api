import { EventEmitter } from "node:events"

import { describe, expect, it, vi } from "vitest"

import { logEdgeEvent } from "../pipeline/logger.js"
import { RequestLoggingMiddleware, requestIdFromHeader } from "./request-logging.middleware.js"
import {
  currentLogCorrelation,
  runWithLogCorrelation,
  safeStructuredJson,
  type StructuredLogSink,
} from "./structured-log.js"

function capturingSink(): { lines: string[]; sink: StructuredLogSink } {
  const lines: string[] = []
  return { lines, sink: { write: (line) => lines.push(line) } }
}

describe("structured logging", () => {
  it("accepts only bounded safe incoming request IDs", () => {
    expect(requestIdFromHeader("client.ID-_123")).toBe("client.ID-_123")
    for (const unsafe of ["", "has space", "a".repeat(129), ["duplicate"], "line\nbreak"]) {
      expect(requestIdFromHeader(unsafe)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
    }
  })

  it("logs completion using the route template without request data", () => {
    const { lines, sink } = capturingSink()
    const middleware = new RequestLoggingMiddleware(sink)
    const response = Object.assign(new EventEmitter(), {
      statusCode: 422,
      setHeader: vi.fn(),
    })
    const request = {
      headers: {
        "x-request-id": "safe-id",
        authorization: "Bearer secret",
        cookie: "session=secret",
      },
      method: "POST",
      baseUrl: "/events",
      route: { path: "/:eventId" },
      originalUrl: "/events/private-value?invite=ABCDEFGHIJKLMNOPQRSTUVWX",
      body: { email: "private@example.com" },
      query: { invite: "ABCDEFGHIJKLMNOPQRSTUVWX" },
    }

    middleware.use(request as never, response as never, () => response.emit("finish"))

    expect(response.setHeader).toHaveBeenCalledWith("X-Request-ID", "safe-id")
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "http_request_completed",
      request_id: "safe-id",
      method: "POST",
      route: "/events/:eventId",
      status: 422,
    })
    expect(lines[0]).not.toContain("private")
    expect(lines[0]).not.toContain("Bearer")
    expect(lines[0]).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWX")
  })

  it("keeps nested and concurrent correlations isolated and immutable", async () => {
    const first = capturingSink()
    const second = capturingSink()
    await Promise.all([
      runWithLogCorrelation({ request_id: "request-a", sink: first.sink }, async () => {
        await Promise.resolve()
        logEdgeEvent("log", "nested", { request_id: "spoofed", queue: "spoofed" })
      }),
      runWithLogCorrelation({ queue: "queue-b", job_id: "job-b", sink: second.sink }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        logEdgeEvent("warn", "nested", { job_id: "spoofed" })
      }),
    ])

    expect(JSON.parse(first.lines[0]!)).toMatchObject({ request_id: "request-a", queue: "spoofed" })
    expect(JSON.parse(second.lines[0]!)).toMatchObject({ queue: "queue-b", job_id: "job-b" })
    expect(currentLogCorrelation()).toEqual({})
  })

  it("redacts and safely serializes cycles, BigInt, errors, and sensitive fields", () => {
    const value: Record<string, unknown> = {
      count: 42n,
      authorization: "secret",
      error: new Error("private diagnostic"),
    }
    value.self = value
    const serialized = safeStructuredJson(value)
    expect(JSON.parse(serialized)).toEqual({
      count: "42",
      authorization: "[REDACTED]",
      error: { name: "Error", message: "private diagnostic", code: "[REDACTED]" },
      self: "[CIRCULAR]",
    })
  })
})
