/**
 * Scheduled notification runs are serial and intentionally do not retry after
 * partial delivery. Twelve hours accommodates at least 1,000 recipients when
 * both provider calls consume their full ten-second timeout, while remaining
 * below the daily reminder interval.
 */
export const SCHEDULED_NOTIFICATION_EXPIRE_SECONDS = 12 * 60 * 60
export const SCHEDULED_NOTIFICATION_CAPACITY_RECIPIENTS = 1_000
export const SCHEDULED_NOTIFICATION_PROVIDER_TIMEOUT_SECONDS = 10
export const SCHEDULED_NOTIFICATION_CHANNELS_PER_RECIPIENT = 2

export function scheduledNotificationCapacitySeconds(): number {
  return (
    SCHEDULED_NOTIFICATION_CAPACITY_RECIPIENTS *
    SCHEDULED_NOTIFICATION_PROVIDER_TIMEOUT_SECONDS *
    SCHEDULED_NOTIFICATION_CHANNELS_PER_RECIPIENT
  )
}
