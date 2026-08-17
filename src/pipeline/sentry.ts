// Sentry capture seam. Upstream (family-events-backend _shared/sentry.ts)
// initializes the Deno Sentry SDK and captures exceptions with context; the
// API's real Sentry wiring is U32 scope. Ported call sites keep calling
// captureEdgeException so U32 only has to fill in this module — until then the
// error is already visible via the adjacent logEdgeEvent call at every call
// site, so this is intentionally a no-op rather than duplicate logging.

export async function captureEdgeException(
  _error: unknown,
  _context: Record<string, unknown> = {}
): Promise<void> {
  // U32: initialize @sentry/node and forward error + context here.
}
