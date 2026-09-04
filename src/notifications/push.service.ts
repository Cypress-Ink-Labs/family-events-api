import { Injectable, Logger, Optional } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import {
  guardedFetch,
  SsrfRejectedError,
  type PublicIpResolver,
} from "../pipeline/ingestion/guarded-fetch.js"
import {
  PushRepository,
  type PushSubscriptionRow,
  type PushVaultCredentials,
} from "./push.repository.js"
import {
  buildApnsRequest,
  buildFcmEndpoint,
  buildFcmMessage,
  getFcmAccessToken,
  parseFcmServiceAccount,
  signApnsJwt,
  type ApnsCredentials,
  type FcmCredentials,
} from "./push/mobile-push.js"
import {
  buildVapidAuth,
  encryptPayload,
  webPushBody,
  type VapidCredentials,
} from "./push/web-push.js"

const PUSH_TIMEOUT_MS = 10_000
const DEFAULT_VAPID_SUBJECT = "mailto:push@cypress-ink-labs.org"
const DEFAULT_APNS_BUNDLE_ID = "com.familyevents.app"

export interface SendPushInput {
  userIds: string[]
  title: string
  body: string
  url?: string
}

export interface SendPushResult {
  sent: number
  failed: number
  pruned: number
  skipped: number
}

export interface PushServiceDependencies {
  fetch?: typeof fetch
  resolve?: PublicIpResolver
  guardedFetch?: typeof guardedFetch
  now?: () => number
  signApnsJwt?: typeof signApnsJwt
  getFcmAccessToken?: typeof getFcmAccessToken
}

interface ResolvedCredentials {
  vapid?: VapidCredentials
  apns?: ApnsCredentials
  fcm?: FcmCredentials
}

function partition(rows: PushSubscriptionRow[]): {
  web: PushSubscriptionRow[]
  apns: PushSubscriptionRow[]
  fcm: PushSubscriptionRow[]
} {
  return {
    web: rows.filter((row) => row.platform === "web"),
    apns: rows.filter((row) => row.platform === "ios"),
    fcm: rows.filter((row) => row.platform === "android"),
  }
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name)

  constructor(
    private readonly repository: PushRepository,
    private readonly config: ConfigService<Env, true>,
    @Optional() private readonly dependencies: PushServiceDependencies = {}
  ) {}

  async send(input: SendPushInput): Promise<SendPushResult> {
    const subscriptions = await this.repository.listSubscriptions(input.userIds)
    if (subscriptions.length === 0) {
      return { sent: 0, failed: 0, pruned: 0, skipped: 0 }
    }

    const credentials = await this.resolveCredentials()
    const groups = partition(subscriptions)
    const result: SendPushResult = { sent: 0, failed: 0, pruned: 0, skipped: 0 }
    const expiredIds: string[] = []

    if (!credentials.vapid) {
      result.skipped += groups.web.length
      this.logSkipped("web", groups.web.length)
    } else {
      await this.sendWeb(groups.web, credentials.vapid, input, result, expiredIds)
    }

    if (!credentials.apns) {
      result.skipped += groups.apns.length
      this.logSkipped("apns", groups.apns.length)
    } else {
      await this.sendApns(groups.apns, credentials.apns, input, result, expiredIds)
    }

    if (!credentials.fcm) {
      result.skipped += groups.fcm.length
      this.logSkipped("fcm", groups.fcm.length)
    } else {
      await this.sendFcm(groups.fcm, credentials.fcm, input, result, expiredIds)
    }

    if (expiredIds.length > 0) {
      const uniqueExpiredIds = [...new Set(expiredIds)]
      try {
        await this.repository.deleteExpiredSubscriptions(uniqueExpiredIds)
        result.pruned = uniqueExpiredIds.length
      } catch {
        result.failed += uniqueExpiredIds.length
        this.logger.warn(`push prune failed: category=database count=${uniqueExpiredIds.length}`)
      }
    }

    this.logger.log(
      `push delivery complete: sent=${result.sent} failed=${result.failed} pruned=${result.pruned} skipped=${result.skipped}`
    )
    return result
  }

  private async resolveCredentials(): Promise<ResolvedCredentials> {
    let vault: PushVaultCredentials = {}
    try {
      vault = await this.repository.loadCredentials()
    } catch {
      this.logger.warn("push credential lookup failed: vault_unavailable")
    }
    const value = (vaultName: keyof PushVaultCredentials, envName: keyof Env): string =>
      vault[vaultName] || ((this.config.get(envName, { infer: true }) as string | undefined) ?? "")

    const vapidPrivateKey = value("vapid_private_key", "VAPID_PRIVATE_KEY")
    const vapidPublicKey = value("vapid_public_key", "VAPID_PUBLIC_KEY")
    const vapidSubject = value("vapid_subject", "VAPID_SUBJECT") || DEFAULT_VAPID_SUBJECT
    const vapid =
      vapidPrivateKey && vapidPublicKey
        ? { privateKey: vapidPrivateKey, publicKey: vapidPublicKey, subject: vapidSubject }
        : undefined

    const apnsTeamId = value("apns_team_id", "APNS_TEAM_ID")
    const apnsKeyId = value("apns_key_id", "APNS_KEY_ID")
    const apnsPrivateKey = value("apns_private_key", "APNS_PRIVATE_KEY")
    const apnsBundleId = value("apns_bundle_id", "APNS_BUNDLE_ID") || DEFAULT_APNS_BUNDLE_ID
    const apnsEnvironment = value("apns_environment", "APNS_ENVIRONMENT")
    const apns =
      apnsTeamId && apnsKeyId && apnsPrivateKey && apnsBundleId
        ? {
            teamId: apnsTeamId,
            keyId: apnsKeyId,
            privateKey: apnsPrivateKey,
            bundleId: apnsBundleId,
            environment:
              apnsEnvironment === "sandbox" ? ("sandbox" as const) : ("production" as const),
          }
        : undefined

    let fcm: FcmCredentials | undefined
    try {
      const parsed = parseFcmServiceAccount(
        value("fcm_service_account_json", "FCM_SERVICE_ACCOUNT_JSON")
      )
      fcm = parsed?.projectId && parsed.clientEmail && parsed.privateKey ? parsed : undefined
    } catch {
      this.logger.warn("push credentials invalid: category=fcm_json")
    }
    return { vapid, apns, fcm }
  }

  private async sendWeb(
    subscriptions: PushSubscriptionRow[],
    credentials: VapidCredentials,
    input: SendPushInput,
    result: SendPushResult,
    expiredIds: string[]
  ): Promise<void> {
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      ...(input.url ? { url: input.url } : {}),
    })
    for (const subscription of subscriptions) {
      if (!subscription.endpoint || !subscription.p256dh || !subscription.authKey) {
        result.failed++
        this.logger.warn("web push failed: category=invalid_subscription")
        continue
      }
      try {
        const authorization = await buildVapidAuth(
          subscription.endpoint,
          credentials,
          this.dependencies.now
        )
        const encrypted = await encryptPayload(payload, subscription.p256dh, subscription.authKey)
        const response = await (this.dependencies.guardedFetch ?? guardedFetch)(
          subscription.endpoint,
          {
            method: "POST",
            headers: {
              Authorization: authorization,
              "Content-Encoding": "aes128gcm",
              "Content-Type": "application/octet-stream",
              TTL: "86400",
              Urgency: "normal",
            },
            body: webPushBody(encrypted),
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          },
          { resolve: this.dependencies.resolve }
        )
        this.recordResponse("web", response, [404, 410], subscription.id, result, expiredIds)
      } catch (error) {
        result.failed++
        const category = error instanceof SsrfRejectedError ? "ssrf_rejected" : "crypto_network"
        this.logger.warn(`web push failed: category=${category}`)
      }
    }
  }

  private async sendApns(
    subscriptions: PushSubscriptionRow[],
    credentials: ApnsCredentials,
    input: SendPushInput,
    result: SendPushResult,
    expiredIds: string[]
  ): Promise<void> {
    if (subscriptions.length === 0) return
    let jwt: string
    try {
      jwt = await (this.dependencies.signApnsJwt ?? signApnsJwt)(credentials, this.dependencies.now)
    } catch {
      result.failed += subscriptions.length
      this.logger.warn(
        `apns push failed: category=credential_signing count=${subscriptions.length}`
      )
      return
    }
    for (const subscription of subscriptions) {
      if (!subscription.token) {
        result.failed++
        this.logger.warn("apns push failed: category=invalid_subscription")
        continue
      }
      try {
        const request = buildApnsRequest({
          token: subscription.token,
          jwt,
          bundleId: credentials.bundleId,
          environment: credentials.environment,
          payload: input,
        })
        const response = await (this.dependencies.fetch ?? fetch)(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        })
        this.recordResponse("apns", response, [400, 410], subscription.id, result, expiredIds)
      } catch {
        result.failed++
        this.logger.warn("apns push failed: category=network_timeout")
      }
    }
  }

  private async sendFcm(
    subscriptions: PushSubscriptionRow[],
    credentials: FcmCredentials,
    input: SendPushInput,
    result: SendPushResult,
    expiredIds: string[]
  ): Promise<void> {
    if (subscriptions.length === 0) return
    let accessToken: string
    try {
      accessToken = await (this.dependencies.getFcmAccessToken ?? getFcmAccessToken)(credentials, {
        fetch: this.dependencies.fetch,
        now: this.dependencies.now,
      })
    } catch {
      result.failed += subscriptions.length
      this.logger.warn(`fcm push failed: category=access_token count=${subscriptions.length}`)
      return
    }
    for (const subscription of subscriptions) {
      if (!subscription.token) {
        result.failed++
        this.logger.warn("fcm push failed: category=invalid_subscription")
        continue
      }
      try {
        const response = await (this.dependencies.fetch ?? fetch)(
          buildFcmEndpoint(credentials.projectId),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(
              buildFcmMessage({
                token: subscription.token,
                title: input.title,
                body: input.body,
                url: input.url,
              })
            ),
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          }
        )
        this.recordResponse("fcm", response, [400, 404], subscription.id, result, expiredIds)
      } catch {
        result.failed++
        this.logger.warn("fcm push failed: category=network_timeout")
      }
    }
  }

  private recordResponse(
    provider: "web" | "apns" | "fcm",
    response: Response,
    pruneStatuses: number[],
    subscriptionId: string,
    result: SendPushResult,
    expiredIds: string[]
  ): void {
    if (response.ok) {
      result.sent++
    } else if (pruneStatuses.includes(response.status)) {
      expiredIds.push(subscriptionId)
      this.logger.log(`${provider} push expired: status=${response.status}`)
    } else {
      result.failed++
      this.logger.warn(`${provider} push rejected: status=${response.status}`)
    }
  }

  private logSkipped(provider: "web" | "apns" | "fcm", count: number): void {
    if (count > 0) {
      this.logger.warn(`${provider} push skipped: category=missing_credentials count=${count}`)
    }
  }
}
