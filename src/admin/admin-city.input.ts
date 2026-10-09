import { BadRequestException } from "@nestjs/common"
import { z } from "zod"

const nonempty = z.string().trim().min(1)
const timezone = nonempty.refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}, "Timezone must be an IANA timezone")
const create = z.strictObject({
  name: nonempty,
  slug: nonempty,
  state: z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((value) => value || null),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .default("US"),
  timezone,
})
const active = z.strictObject({ is_active: z.boolean() })
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new BadRequestException("invalid city request")
  return result.data
}
export type AdminCreateCityInput = z.infer<typeof create>
export const parseAdminCreateCity = (value: unknown) => parse(create, value)
export const parseAdminCityActive = (value: unknown) => parse(active, value)
export const parseAdminCityId = (value: unknown) => parse(z.uuid(), value)
export const parseAdminCityQuery = (value: unknown) => parse(z.strictObject({}), value)
