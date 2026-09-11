import { randomUUID } from "node:crypto"

import { Inject, Injectable } from "@nestjs/common"
import type { NextFunction, Request, Response } from "express"

import {
  emitStructuredLog,
  runWithLogCorrelation,
  STRUCTURED_LOG_SINK,
  type StructuredLogSink,
} from "./structured-log.js"

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function requestIdFromHeader(value: unknown): string {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value) ? value : randomUUID()
}

function routeTemplate(request: Request): string {
  const path = (request.route as { path?: unknown } | undefined)?.path
  if (typeof path !== "string") return "<unmatched>"
  // baseUrl is generated from mounted router definitions, not the request URL.
  return `${request.baseUrl}${path}` || "/"
}

@Injectable()
export class RequestLoggingMiddleware {
  constructor(@Inject(STRUCTURED_LOG_SINK) private readonly sink: StructuredLogSink) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = requestIdFromHeader(request.headers["x-request-id"])
    const started = performance.now()
    response.setHeader("X-Request-ID", requestId)

    runWithLogCorrelation({ request_id: requestId, sink: this.sink }, () => {
      response.once("finish", () => {
        emitStructuredLog(
          {
            event: "http_request_completed",
            request_id: requestId,
            method: request.method,
            route: routeTemplate(request),
            status: response.statusCode,
            duration_ms: Math.round((performance.now() - started) * 100) / 100,
          },
          this.sink
        )
      })
      next()
    })
  }
}
