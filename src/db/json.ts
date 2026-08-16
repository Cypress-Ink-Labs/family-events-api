/**
 * Recursive JSON type for jsonb columns.
 *
 * Deliberately not `unknown`: the previous TanStack Start data layer proved that
 * `unknown` jsonb typing breaks serialization typing at every call site, so the
 * same recursive type convention carries over to the API (decision recorded in
 * the production-readiness plan, U6).
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
