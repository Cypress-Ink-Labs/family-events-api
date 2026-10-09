import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type { Env } from "../config/env.js"
import { NotificationPreferencesRepository } from "../data/notification-preferences.repository.js"
import { PushRepository } from "../notifications/push.repository.js"
import { base64urlDecode, buildVapidAuth } from "../notifications/push/web-push.js"
import { isFamilyEnabled } from "../pipeline/flags.js"
import type {
  NotificationDeliveryDto,
  NotificationSettingsDto,
} from "./notification-preferences.dto.js"
import type {
  BrowserSubscriptionDto,
  BrowserSubscriptionInputDto,
  NotificationPreferencesUpdateDto,
} from "./notification-preferences.dto.js"

@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly preferences: NotificationPreferencesRepository,
    private readonly push: PushRepository,
    private readonly config: ConfigService<Env, true>
  ) {}

  async delivery(): Promise<NotificationDeliveryDto> {
    const vault = await this.push.loadCredentials()
    const publicKey = vault.vapid_public_key || this.config.get("VAPID_PUBLIC_KEY", { infer: true })
    const privateKey =
      vault.vapid_private_key || this.config.get("VAPID_PRIVATE_KEY", { infer: true })
    let configured = false
    if (publicKey && privateKey) {
      try {
        await buildVapidAuth("https://fcm.googleapis.com", {
          publicKey,
          privateKey,
          subject:
            vault.vapid_subject ||
            this.config.get("VAPID_SUBJECT", { infer: true }) ||
            "mailto:push@cypress-ink-labs.org",
        })
        configured = true
      } catch {
        configured = false
      }
    }
    const flags = {
      NODE_ENV: this.config.get("NODE_ENV", { infer: true }),
      CUTOVER_REMINDERS: this.config.get("CUTOVER_REMINDERS", { infer: true }),
      CUTOVER_NOTIFY: this.config.get("CUTOVER_NOTIFY", { infer: true }),
      CUTOVER_DIGEST: this.config.get("CUTOVER_DIGEST", { infer: true }),
    }
    const gates = await this.preferences.deliveryGates().catch(() => {
      throw new ServiceUnavailableException("Notification delivery status is unavailable")
    })
    return {
      email_configured: !!this.config.get("RESEND_API_KEY", { infer: true }),
      web_push_configured: configured,
      vapid_public_key: configured ? publicKey! : null,
      digest_push_supported: false,
      reminders_enabled: isFamilyEnabled("reminders", flags) && gates.reminders,
      changes_enabled: isFamilyEnabled("notify", flags) && gates.notify,
      digest_enabled: isFamilyEnabled("digest", flags) && gates.digest,
    }
  }

  async get(userId: string): Promise<NotificationSettingsDto> {
    const [preferences, delivery, subscriptions] = await Promise.all([
      this.preferences.get(userId),
      this.delivery(),
      this.preferences.subscriptions(userId),
    ])
    return { preferences, delivery, subscriptions }
  }

  async update(
    userId: string,
    input: NotificationPreferencesUpdateDto
  ): Promise<NotificationSettingsDto> {
    if (
      (input.reminder_push === true || input.change_push === true) &&
      !(await this.delivery()).web_push_configured
    )
      throw new ServiceUnavailableException("Browser push is not configured")
    await this.preferences.update(userId, input)
    return this.get(userId)
  }

  async register(
    userId: string,
    input: BrowserSubscriptionInputDto
  ): Promise<BrowserSubscriptionDto> {
    if (!(await this.delivery()).web_push_configured)
      throw new ServiceUnavailableException("Browser push is not configured")
    try {
      const publicKey = Uint8Array.from(base64urlDecode(input.p256dh))
      await crypto.subtle.importKey(
        "raw",
        publicKey.buffer,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
      )
    } catch {
      throw new BadRequestException("Invalid browser subscription public key")
    }
    return this.preferences.register(userId, input)
  }

  async remove(userId: string, id: string): Promise<NotificationSettingsDto> {
    await this.preferences.remove(userId, id)
    return this.get(userId)
  }
}
