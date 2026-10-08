import { FAMILIES, JOB_FAMILIES } from "./families.js"

export function internalGateLabel(family: string, key: string): string {
  return `internal:${family}:${key}`
}

export function scheduledOperations() {
  return JOB_FAMILIES.flatMap((family) =>
    FAMILIES[family].schedules.map((schedule) => ({
      ...schedule,
      family,
      queue: FAMILIES[family].queue,
      label: schedule.replaces ?? `cron-${schedule.key}`,
      gateLabel:
        schedule.replaces === null
          ? internalGateLabel(family, schedule.key)
          : `nestjs:${schedule.replaces}`,
      payload: { task: family === "digest" || family === "reminders" ? "send" : schedule.task },
    }))
  )
}
