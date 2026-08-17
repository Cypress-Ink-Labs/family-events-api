// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/lib/parser-context.ts (U28).

export interface ParserFetchOptions {
  accept?: string
}

export interface ParserContext {
  timezone: string
  fetchText: (url: string, opts?: ParserFetchOptions) => Promise<string>
  fetchJson: <T = unknown>(url: string, opts?: ParserFetchOptions) => Promise<T>
}
