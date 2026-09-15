export const FAMILY_NEED_CLAIMS = [
  "indoor",
  "outdoor",
  "wheelchair_accessible",
  "sensory_friendly",
  "stroller_friendly",
] as const

export type FamilyNeedClaim = (typeof FAMILY_NEED_CLAIMS)[number]
export type FamilyNeedState = "confirmed" | "contradicted" | "unknown"
export type FamilyNeedProvenance = "source_statement" | "human" | "organizer"
export type FamilyNeedValue = "supported" | "unsupported"

export interface FamilyNeedSelection {
  familyNeeds: FamilyNeedClaim[]
  includeUnknown: boolean
}

/** One shared predicate description is consumed by both Explore and Map SQL. */
export function familyNeedsPredicateSql(
  eventAlias: string,
  parameters: {
    familyNeeds: number
    includeUnknown: number
  }
): string {
  return `NOT EXISTS (
    SELECT selected.claim
    FROM unnest($${parameters.familyNeeds}::text[]) AS selected(claim)
    LEFT JOIN public.event_family_needs n
      ON n.event_id = ${eventAlias}.id AND n.claim::text = selected.claim
    WHERE CASE
      WHEN n.state = 'confirmed' THEN false
      WHEN n.state = 'contradicted' THEN true
      ELSE NOT $${parameters.includeUnknown}::boolean
    END
  )`
}

export function isExplicitSourceStatement(input: {
  provenanceType: string
  sourceUrl?: string | null
  statement?: string | null
}): boolean {
  return (
    input.provenanceType === "source_statement" &&
    Boolean(input.sourceUrl?.trim()) &&
    Boolean(input.statement?.trim())
  )
}
