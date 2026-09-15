import { BadRequestException } from "@nestjs/common"
import { z } from "zod"

import { FAMILY_NEED_CLAIMS } from "./family-needs.js"

const evidenceSchema = z.strictObject({
  claim: z.enum(FAMILY_NEED_CLAIMS),
  value: z.enum(["supported", "unsupported"]),
  provenance_type: z.enum(["source_statement", "human", "organizer"]),
  source_url: z.url().nullable().optional(),
  statement: z.string().trim().min(1).max(4000),
  observed_at: z.iso.datetime({ offset: true }),
})

const reassessSchema = z.strictObject({
  evidence_id: z.uuid(),
  reason: z.string().trim().min(1).max(1000),
})

export type FamilyNeedEvidenceInput = z.infer<typeof evidenceSchema>
export type FamilyNeedReassessmentInput = z.infer<typeof reassessSchema>

export function parseFamilyNeedEvidence(input: unknown): FamilyNeedEvidenceInput {
  const result = evidenceSchema.safeParse(input)
  if (
    !result.success ||
    (result.data.provenance_type === "source_statement" && !result.data.source_url)
  ) {
    throw new BadRequestException("invalid family-needs evidence")
  }
  return result.data
}

export function parseFamilyNeedReassessment(input: unknown): FamilyNeedReassessmentInput {
  const result = reassessSchema.safeParse(input)
  if (!result.success) throw new BadRequestException("invalid family-needs reassessment")
  return result.data
}
