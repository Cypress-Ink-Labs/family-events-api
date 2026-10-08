import { BadRequestException } from "@nestjs/common"
import { z } from "zod"
import { base64urlDecode, isTrustedWebPushEndpoint } from "../notifications/push/web-push.js"

const preferenceInput = z
  .strictObject({
    reminder_email: z.boolean().optional(),
    reminder_push: z.boolean().optional(),
    change_email: z.boolean().optional(),
    change_push: z.boolean().optional(),
    digest_email: z.boolean().optional(),
    digest_push: z.boolean().optional(),
    browser_subscription_id: z.uuid().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== "browser_subscription_id"))

export function parseNotificationPreferences(value: unknown): z.infer<typeof preferenceInput> {
  const parsed = preferenceInput.safeParse(value)
  if (!parsed.success) throw new BadRequestException("Invalid notification preferences")
  return parsed.data
}

const encoded = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/)
const subscriptionInput = z.strictObject({
  endpoint: z
    .url()
    .max(4096)
    .refine((value) => {
      const url = new URL(value)
      return (
        isTrustedWebPushEndpoint(value) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        (!url.port || url.port === "443")
      )
    }),
  p256dh: encoded.refine((value) => {
    try {
      const decoded = base64urlDecode(value)
      return decoded.length === 65 && decoded[0] === 4
    } catch {
      return false
    }
  }),
  auth_key: encoded.refine((value) => {
    try {
      return base64urlDecode(value).length === 16
    } catch {
      return false
    }
  }),
})

export function parseBrowserSubscription(value: unknown): z.infer<typeof subscriptionInput> {
  const parsed = subscriptionInput.safeParse(value)
  if (!parsed.success) throw new BadRequestException("Invalid browser push subscription")
  return parsed.data
}
