import { describe, expect, it } from "vitest"

import {
  resolveCompletedTagQueueStatus,
  shouldStopBeforeStartingNextTagRow,
} from "./queue-policy.js"

// Ported from family-events-backend process-tag-queue/queue-policy_test.ts (U29),
// converted from Deno.test to vitest. Scenarios and expected values unchanged.

describe("resolveCompletedTagQueueStatus", () => {
  it("marks successful jobs succeeded", () => {
    expect(resolveCompletedTagQueueStatus()).toBe("succeeded")
  })
})

describe("shouldStopBeforeStartingNextTagRow", () => {
  it("stops before budget exhaustion", () => {
    expect(shouldStopBeforeStartingNextTagRow(104_999, 110_000)).toBe(false)
    expect(shouldStopBeforeStartingNextTagRow(105_000, 110_000)).toBe(true)
  })
})
