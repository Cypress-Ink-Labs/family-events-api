import { AsyncLocalStorage } from "node:async_hooks"

import { redact } from "./redaction.js"

export interface StructuredLogSink {
  write(line: string): void
}

export const STRUCTURED_LOG_SINK = Symbol("STRUCTURED_LOG_SINK")

export const consoleStructuredLogSink: StructuredLogSink = {
  write(line) {
    console.log(line)
  },
}

export interface LogCorrelation {
  request_id?: string
  queue?: string
  job_id?: string
  sink?: StructuredLogSink
}

const storage = new AsyncLocalStorage<Readonly<LogCorrelation>>()

export function runWithLogCorrelation<T>(correlation: LogCorrelation, fn: () => T): T {
  return storage.run(Object.freeze({ ...correlation }), fn)
}

export function currentLogCorrelation(): Readonly<LogCorrelation> {
  return storage.getStore() ?? {}
}

/** Redacts and bounds a payload before performing a serialization that cannot throw. */
export function safeStructuredJson(payload: unknown): string {
  try {
    return JSON.stringify(redact(payload))
  } catch {
    return '{"event":"structured_log_serialization_failed"}'
  }
}

export function emitStructuredLog(
  payload: Record<string, unknown>,
  sink: StructuredLogSink = currentLogCorrelation().sink ?? consoleStructuredLogSink
): void {
  sink.write(safeStructuredJson(payload))
}
