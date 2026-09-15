import { GUARDS_METADATA } from "@nestjs/common/constants.js"
import { describe, expect, it } from "vitest"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminCorrectionReportController } from "./admin-correction-report.controller.js"

describe("AdminCorrectionReportController authorization boundary", () => {
  it("requires authentication, mapped identity, and operator authorization for every route", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminCorrectionReportController)).toEqual([
      ClerkAuthGuard,
      MappedIdentityGuard,
      OperatorGuard,
    ])
  })
})
