import { Injectable, NotFoundException } from "@nestjs/common"

import type {
  FamilyNeedEvidenceInput,
  FamilyNeedReassessmentInput,
} from "./admin-family-needs.input.js"
import {
  AdminFamilyNeedsRepository,
  type FamilyNeedEvidenceRow,
} from "./admin-family-needs.repository.js"

@Injectable()
export class AdminFamilyNeedsService {
  constructor(private readonly evidence: AdminFamilyNeedsRepository) {}

  async add(
    eventId: string,
    operatorId: string,
    input: FamilyNeedEvidenceInput
  ): Promise<FamilyNeedEvidenceRow> {
    try {
      return await this.evidence.add(eventId, operatorId, input)
    } catch (error) {
      if (error instanceof Error && error.message === "EVENT_NOT_FOUND") {
        throw new NotFoundException("event not found")
      }
      throw error
    }
  }

  async reassess(
    eventId: string,
    operatorId: string,
    input: FamilyNeedReassessmentInput
  ): Promise<FamilyNeedEvidenceRow> {
    try {
      return await this.evidence.invalidate(eventId, operatorId, input)
    } catch (error) {
      if (error instanceof Error && error.message === "EVIDENCE_NOT_FOUND") {
        throw new NotFoundException("evidence not found")
      }
      throw error
    }
  }

  async list(eventId: string, operatorId: string): Promise<FamilyNeedEvidenceRow[]> {
    try {
      return await this.evidence.list(eventId, operatorId)
    } catch (error) {
      if (error instanceof Error && error.message === "EVENT_NOT_FOUND") {
        throw new NotFoundException("event not found")
      }
      throw error
    }
  }
}
