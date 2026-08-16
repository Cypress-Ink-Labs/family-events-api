// Per-family cutover flags, ported verbatim from family-events-app
// src/worker/flags.ts (U12): the structural guard against dual-write.
// Until U18, only the old pipeline mutates the pipeline tables — so in
// production a job family is completely absent (no work registration, no
// schedules, no queues) unless its flag is explicitly set. This is a
// creation-time gate, not a runtime pause bit.
//
// Outside production the default flips to enabled so local and CI runs can
// exercise the worker without ceremony; an explicit `false` still disables.

import { JOB_FAMILIES, type JobFamily } from "./families.js"

export function cutoverFlagName(family: JobFamily): string {
  return `CUTOVER_${family.toUpperCase()}`
}

export function isFamilyEnabled(
  family: JobFamily,
  env: Record<string, string | undefined>
): boolean {
  const flag = env[cutoverFlagName(family)]
  if (env["NODE_ENV"] === "production") return flag === "true"
  return flag !== "false"
}

export function enabledFamilies(env: Record<string, string | undefined>): JobFamily[] {
  return JOB_FAMILIES.filter((family) => isFamilyEnabled(family, env))
}
