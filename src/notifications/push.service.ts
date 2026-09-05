import { Injectable, Logger, Optional } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import {
  guardedFetch,
  SsrfRejectedError,
  type PublicIpResolver,
} from "../pipeline/ingestion/guarded-fetch.js"
import { resolveAndCheckPublicIp } from "../pipeline/ingestion/url-resolve.js"
import {
  PushRepository,
  type PushSubscriptionRow,
  type PushVaultCredentials,
} from "./push.repository.js"
import {
  buildFcmEndpoint,
  buildFcmMessage,
  getFcmAccessToken,
  isFcmUnregisteredResponse,
  parseFcmServiceAccount,
  type FcmCredentials,
} from "./push/mobile-push.js"
import {
  buildVapidAuth,
  encryptPayload,
  isTrustedWebPushEndpoint,
  webPushBody,
  type VapidCredentials,
} from "./push/web-push.js"

const PUSH_TIMEOUT_MS = 10_000
const PUSH_CONCURRENCY = 10
const DEFAULT_VAPID_SUBJECT = "mailto:push@cypress-ink-labs.org"

export interface SendPushInput {
  userIds: string[]
  title: string
  body: string
  url?: string
}

export interface SendPushResult {
  requestedRecipients: number
  matchedRecipients: number
  unmatchedRecipients: number
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
  getFcmAccessToken?: typeof getFcmAccessToken
}

interface ResolvedCredentials {
  vapid?: VapidCredentials
  fcm?: FcmCredentials
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

async function forEachConcurrent<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++]
        if (item !== undefined) await work(item)
      }
    })
  )
}

function partition(rows: PushSubscriptionRow[]): {
  web: PushSubscriptionRow[]
  fcm: PushSubscriptionRow[]
} {
  return {
    web: rows.filter((row) => row.platform === "web"),
    fcm: rows.filter((row) => row.platform === "ios" || row.platform === "android"),
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
    const requestedUserIds = unique(input.userIds)
    const subscriptions = await this.repository.listSubscriptions(requestedUserIds)
    const matchedUserIds = new Set(subscriptions.map((subscription) => subscription.userId))
    const result: SendPushResult = {
      requestedRecipients: requestedUserIds.length,
      matchedRecipients: matchedUserIds.size,
      unmatchedRecipients: requestedUserIds.length - matchedUserIds.size,
      sent: 0,
      failed: 0,
      pruned: 0,
      skipped: 0,
    }
    if (subscriptions.length === 0) return result

    const credentials = await this.resolveCredentials()
    const groups = partition(subscriptions)
    const expiredIds: string[] = []

    if (!credentials.vapid) {
      result.skipped += groups.web.length
      this.logSkipped("web", groups.web.length)
    } else {
      await this.sendWeb(groups.web, credentials.vapid, input, result, expiredIds)
    }

    if (!credentials.fcm) {
      result.skipped += groups.fcm.length
      this.logSkipped("fcm", groups.fcm.length)
    } else {
      await this.sendFcm(groups.fcm, credentials.fcm, input, result, expiredIds)
    }

    if (expiredIds.length > 0) {
      const uniqueExpiredIds = unique(expiredIds).toSorted()
      try {
        await this.repository.deleteExpiredSubscriptions(uniqueExpiredIds)
        result.pruned = uniqueExpiredIds.length
      } catch {
        result.failed += uniqueExpiredIds.length
        this.logger.warn(`push prune failed: category=database count=${uniqueExpiredIds.length}`)
      }
    }

    this.logger.log(
      `push delivery complete: requested=${result.requestedRecipients} ` +
        `matched=${result.matchedRecipients} unmatched=${result.unmatchedRecipients} ` +
        `sent=${result.sent} failed=${result.failed} pruned=${result.pruned} ` +
        `skipped=${result.skipped}`
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

    let fcm: FcmCredentials | undefined
    try {
      const parsed = parseFcmServiceAccount(
        value("fcm_service_account_json", "FCM_SERVICE_ACCOUNT_JSON")
      )
      fcm = parsed?.projectId && parsed.clientEmail && parsed.privateKey ? parsed : undefined
    } catch {
      this.logger.warn("push credentials invalid: category=fcm_json")
    }
    return { vapid, fcm }
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
    await forEachConcurrent(subscriptions, PUSH_CONCURRENCY, async (subscription) => {
      if (!subscription.endpoint || !subscription.p256dh || !subscription.authKey) {
        result.failed++
        this.logger.warn("web push failed: category=invalid_subscription")
        return
      }
      if (!isTrustedWebPushEndpoint(subscription.endpoint)) {
        result.failed++
        this.logger.warn("web push failed: category=untrusted_endpoint")
        return
      }
      try {
        const authorization = await buildVapidAuth(
          subscription.endpoint,
          credentials,
          this.dependencies.now
        )
        const encrypted = await encryptPayload(payload, subscription.p256dh, subscription.authKey)
        const resolver: PublicIpResolver = async (url) => {
          if (!isTrustedWebPushEndpoint(url)) {
            return { ok: false, reason: "untrusted or non-HTTPS push provider" }
          }
          return (this.dependencies.resolve ?? resolveAndCheckPublicIp)(url)
        }
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
          { resolve: resolver }
        )
        this.recordWebResponse(response, subscription.id, result, expiredIds)
      } catch (error) {
        result.failed++
        const category = error instanceof SsrfRejectedError ? "ssrf_rejected" : "crypto_network"
        this.logger.warn(`web push failed: category=${category}`)
      }
    })
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
    await forEachConcurrent(subscriptions, PUSH_CONCURRENCY, async (subscription) => {
      if (!subscription.token || subscription.platform === "web") {
        result.failed++
        this.logger.warn("fcm push failed: category=invalid_subscription")
        return
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
                platform: subscription.platform,
                title: input.title,
                body: input.body,
                url: input.url,
              })
            ),
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          }
        )
        if (response.ok) {
          result.sent++
        } else if (await isFcmUnregisteredResponse(response)) {
          expiredIds.push(subscription.id)
          this.logger.log(`fcm push expired: status=${response.status}`)
        } else {
          result.failed++
          this.logger.warn(`fcm push rejected: status=${response.status}`)
        }
      } catch {
        result.failed++
        this.logger.warn("fcm push failed: category=network_timeout")
      }
    })
  }

  private recordWebResponse(
    response: Response,
    subscriptionId: string,
    result: SendPushResult,
    expiredIds: string[]
  ): void {
    if (response.ok) {
      result.sent++
    } else if (response.status === 404 || response.status === 410) {
      expiredIds.push(subscriptionId)
      this.logger.log(`web push expired: status=${response.status}`)
    } else {
      result.failed++
      this.logger.warn(`web push rejected: status=${response.status}`)
    }
  }

  private logSkipped(provider: "web" | "fcm", count: number): void {
    if (count > 0) {
      this.logger.warn(`${provider} push skipped: category=missing_credentials count=${count}`)
    }
  }
}
