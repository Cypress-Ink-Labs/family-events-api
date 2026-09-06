import { describe, expect, it } from "vitest"

import {
  scheduledNotificationCapacitySeconds,
  SCHEDULED_NOTIFICATION_EXPIRE_SECONDS,
} from "./scheduled-notification.js"

describe("scheduled notification runtime budget", () => {
  it("fits 1,000 recipients with two full provider timeouts inside the queue expiration", () => {
    expect(scheduledNotificationCapacitySeconds()).toBe(20_000)
    expect(SCHEDULED_NOTIFICATION_EXPIRE_SECONDS).toBe(43_200)
    expect(scheduledNotificationCapacitySeconds()).toBeLessThan(
      SCHEDULED_NOTIFICATION_EXPIRE_SECONDS
    )
    expect(SCHEDULED_NOTIFICATION_EXPIRE_SECONDS).toBeLessThan(24 * 60 * 60)
  })
  it.each([
    { batchSize: 10, delaySeconds: 0.3, pacingSeconds: 29.7 },
    { batchSize: 5, delaySeconds: 0.5, pacingSeconds: 99.5 },
  ])(
    "includes between-batch pacing for batches of $batchSize",
    ({ batchSize, delaySeconds, pacingSeconds }) => {
      const pacing = (Math.ceil(1_000 / batchSize) - 1) * delaySeconds
      expect(pacing).toBeCloseTo(pacingSeconds)
      expect(scheduledNotificationCapacitySeconds() + pacing).toBeLessThan(
        SCHEDULED_NOTIFICATION_EXPIRE_SECONDS
      )
    }
  )
})
