/**
 * Pure deduplication utilities for cross-source fuzzy matching at ingest time.
 * Ported verbatim from family-events-backend supabase/functions/_shared/dedup-utils.ts
 * (plan 033 semantics: fingerprint match, or Jaccard >= threshold within +/-4h).
 */

import { utcMinute } from "./ingestion/parsing.js"

export const JACCARD_THRESHOLD = 0.7

const FUZZY_WINDOW_MS = 4 * 60 * 60 * 1000

/**
 * Canonicalize a title for comparison:
 * - lowercase
 * - strip punctuation (including em-dash, en-dash, ampersand, and common symbols)
 * - collapse whitespace
 * - trim
 */
export function canonicalizeTitle(title: string): string {
  return (
    title
      .toLowerCase()
      // Replace em-dash / en-dash with space so "Family—Fun" splits correctly
      .replace(/[–—]/g, " ")
      .replace(/&/g, " ")
      // Strip remaining punctuation (keep alphanumerics and spaces)
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

/** Split a title into a token set after canonicalization. Empty tokens are dropped. */
export function titleTokens(title: string): Set<string> {
  const canonical = canonicalizeTitle(title)
  return new Set(canonical.split(" ").filter((token) => token.length > 0))
}

/**
 * Jaccard similarity between two prepared title token sets.
 * Returns 0 when the union is empty (both sets are empty).
 */
export function jaccardFromTokens(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0
  }
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1
    }
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Jaccard similarity between the token sets of two title strings. */
export function jaccardSimilarity(a: string, b: string): number {
  return jaccardFromTokens(titleTokens(a), titleTokens(b))
}

/**
 * Composite fingerprint for an event at minute precision.
 * Format: `${cityId ?? "null"}::${utcMinute(startDatetime)}::${canonicalizeTitle(title)}`
 *
 * Deviation from the verbatim port (PR #14 review): valid timestamps are
 * normalized to their UTC ISO minute first, so equivalent instants written
 * with different offsets produce the same fingerprint. Invalid input keeps
 * the raw-slice fallback (never throws).
 */
export function eventFingerprint(
  title: string,
  startDatetime: string,
  cityId: string | null
): string {
  return `${cityId ?? "null"}::${utcMinute(startDatetime)}::${canonicalizeTitle(title)}`
}

/**
 * Determine if a candidate event is a cross-source duplicate of an existing event.
 *
 * Returns true when EITHER:
 *   1. The fingerprints match exactly (same city + same minute + same canonical title), OR
 *   2. The titles' Jaccard similarity >= threshold within a valid per-pair
 *      +/-4-hour start-time window.
 *
 * NOTE: threshold = 0.7 is conservative enough to avoid most false positives
 * at the cost of missing near-matches like "Family Storytime" vs
 * "Storytime — Family Edition" (~0.67 Jaccard). Field-tune if needed.
 */
export function isCrossSourceDuplicate(
  candidateTitle: string,
  candidateStart: string,
  existingTitle: string,
  existingStart: string,
  cityId: string | null,
  threshold: number = JACCARD_THRESHOLD
): boolean {
  const candidateFp = eventFingerprint(candidateTitle, candidateStart, cityId)
  const existingFp = eventFingerprint(existingTitle, existingStart, cityId)
  if (candidateFp === existingFp) {
    return true
  }

  const timeDifference = Math.abs(
    new Date(candidateStart).getTime() - new Date(existingStart).getTime()
  )
  return (
    Number.isFinite(timeDifference) &&
    timeDifference <= FUZZY_WINDOW_MS &&
    jaccardSimilarity(candidateTitle, existingTitle) >= threshold
  )
}
