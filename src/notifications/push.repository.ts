import { Injectable, Logger } from "@nestjs/common"

import { DbService } from "../db/db.service.js"

export const MAX_PUSH_USER_IDS = 1_000

export type PushPlatform = "web" | "ios" | "android"

export interface PushSubscriptionRow {
  id: string
  userId: string
  platform: PushPlatform
  endpoint: string | null
  token: string | null
  p256dh: string | null
  authKey: string | null
}

export const PUSH_CREDENTIAL_NAMES = [
  "vapid_private_key",
  "vapid_public_key",
  "vapid_subject",
  "fcm_service_account_json",
] as const

export type PushCredentialName = (typeof PUSH_CREDENTIAL_NAMES)[number]
export type PushVaultCredentials = Partial<Record<PushCredentialName, string>>

interface PushCredentialRow {
  name: string
  decryptedSecret: string | null
}

const LIST_SUBSCRIPTIONS_SQL = `
SELECT
  id,
  user_id AS "userId",
  platform,
  endpoint,
  token,
  p256dh,
  auth_key AS "authKey"
FROM public.push_subscriptions
WHERE user_id = ANY($1::uuid[])
ORDER BY user_id, created_at, id
`

const DELETE_SUBSCRIPTIONS_SQL = `
DELETE FROM public.push_subscriptions
WHERE id = ANY($1::uuid[])
`

const LOAD_CREDENTIALS_SQL = `
SELECT name, decrypted_secret AS "decryptedSecret"
FROM vault.decrypted_secrets
WHERE name = ANY($1::text[])
`

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

@Injectable()
export class PushRepository {
  private readonly logger = new Logger(PushRepository.name)

  constructor(private readonly db: DbService) {}

  async listSubscriptions(userIds: string[]): Promise<PushSubscriptionRow[]> {
    const boundedUserIds = unique(userIds)
    if (boundedUserIds.length === 0) return []
    if (boundedUserIds.length > MAX_PUSH_USER_IDS) {
      throw new RangeError(`push recipient limit is ${MAX_PUSH_USER_IDS}`)
    }
    return this.db.query<PushSubscriptionRow>(LIST_SUBSCRIPTIONS_SQL, [boundedUserIds])
  }

  async deleteExpiredSubscriptions(subscriptionIds: string[]): Promise<void> {
    const expiredIds = unique(subscriptionIds)
    if (expiredIds.length === 0) return
    await this.db.query(DELETE_SUBSCRIPTIONS_SQL, [expiredIds])
  }

  async loadCredentials(): Promise<PushVaultCredentials> {
    try {
      const rows = await this.db.query<PushCredentialRow>(LOAD_CREDENTIALS_SQL, [
        PUSH_CREDENTIAL_NAMES,
      ])
      const credentials: PushVaultCredentials = {}
      for (const row of rows) {
        if (PUSH_CREDENTIAL_NAMES.includes(row.name as PushCredentialName) && row.decryptedSecret) {
          credentials[row.name as PushCredentialName] = row.decryptedSecret
        }
      }
      return credentials
    } catch {
      this.logger.warn("push credential lookup failed: vault_unavailable")
      return {}
    }
  }
}
