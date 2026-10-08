import { BadRequestException } from "@nestjs/common"
import { z } from "zod"

const name = z
  .string()
  .trim()
  .transform((value) => value || null)
  .nullable()
  .optional()
const profileInput = z
  .strictObject({
    display_name: name,
    child_name: name,
    child_age: z.int().min(0).max(18).nullable().optional(),
    theme_preference: z.enum(["light", "dark", "system"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one profile setting")

export type ProfileUpdate = z.infer<typeof profileInput>

export function parseProfileUpdate(value: unknown): ProfileUpdate {
  const result = profileInput.safeParse(value)
  if (!result.success) throw new BadRequestException("Invalid profile settings")
  return result.data
}
