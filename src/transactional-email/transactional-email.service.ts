import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  ConflictException,
  NotFoundException,
  HttpException,
  type OnModuleInit,
} from "@nestjs/common"
import type { PoolClient } from "pg"
import { ConfigService } from "@nestjs/config"
import {
  withAdminActor,
  requireDatabaseAdmin,
  isDatabaseAdminDenial,
} from "../admin/admin-database.js"
import type { Env } from "../config/env.js"
import { DbService } from "../db/db.service.js"
import { JobsService } from "../jobs/jobs.service.js"
import { MailService, type SendMailInput } from "../notifications/mail.service.js"
import { isFamilyEnabled } from "../pipeline/flags.js"

const QUEUE = "transactional-email"
type Delivery = Omit<SendMailInput, "signal" | "idempotencyKey">
interface Entry {
  id: string
  kind:
    | "welcome"
    | "admin_request"
    | "request_approved"
    | "request_rejected"
    | "community_event_approved"
    | "community_event_rejected"
  target_id: string | null
  payload: {
    email: string
    message?: string | null
    code?: string
    username?: string
    event_title?: string
    event_id?: string
  } | null
  delivery: Delivery | null
  attempts: number
  first_attempt_at: string | null
}
function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
@Injectable()
export class TransactionalEmailService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService<Env, true>,
    private readonly mail: MailService,
    private readonly jobs: JobsService
  ) {}
  private enabled() {
    return isFamilyEnabled("notify", {
      NODE_ENV: this.config.get("NODE_ENV", { infer: true }),
      CUTOVER_NOTIFY: this.config.get("CUTOVER_NOTIFY", { infer: true }),
    })
  }
  onModuleInit() {
    if (!this.enabled()) {
      this.jobs.registerScheduleRemoval(QUEUE, "transactional-email-outbox")
      return
    }
    this.jobs.registerQueue(
      QUEUE,
      (data, _id, signal) => this.handleJob(data, signal),
      { name: QUEUE, retryLimit: 0, expireInSeconds: 300 },
      {
        localConcurrency: 1,
        schedules: [
          { cron: "* * * * *", data: { task: "process" }, key: "transactional-email-outbox" },
        ],
      }
    )
  }
  private render(row: Entry): Delivery | null {
    const payload = row.payload
    if (!payload) return null
    const appUrl =
      this.config.get("APP_URL", { infer: true }) ?? "https://family-events.up.railway.app"
    const origin = new URL(appUrl)
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password)
      throw new Error("invalid app URL")
    const from =
      this.config.get("RESEND_FROM", { infer: true }) ?? "Family Events <onboarding@resend.dev>"
    const common = { from, to: payload.email }
    if (row.kind === "welcome")
      return {
        ...common,
        subject: "Welcome to Family Events",
        templateId: "family-events-welcome",
        variables: {
          USERNAME: payload.username ?? "",
          APP_URL: origin.toString().replace(/\/$/, ""),
        },
      }
    const inline = {
      ...common,
      ...(this.config.get("RESEND_REPLY_TO", { infer: true })
        ? { replyTo: this.config.get("RESEND_REPLY_TO", { infer: true }) }
        : {}),
    }
    if (row.kind === "community_event_approved" || row.kind === "community_event_rejected") {
      const approved = row.kind === "community_event_approved"
      const title = payload.event_title ?? ""
      const target = approved ? `/events/${payload.event_id}` : "/submit-event"
      return {
        ...inline,
        subject: approved
          ? `Your event "${title}" is now live!`
          : `Update on your event "${title}"`,
        html: `<h1>${approved ? "Event Approved!" : "Event Review Update"}</h1><p>Hi ${escape(payload.username ?? "")},</p><p>${escape(title)}</p><p>${approved ? "Your event has been approved and is now live on Family Events. Local families can discover it and add it to their calendars." : "Thanks for submitting your event. After review, we were unable to publish it at this time. You are welcome to submit other events."}</p><p><a href="${escape(new URL(target, origin).toString())}">${approved ? "View Your Event" : "Submit Another Event"}</a></p>`,
      }
    }
    if (row.kind === "admin_request") {
      const recipient = this.config.get("ADMIN_NOTIFY_EMAIL", { infer: true })
      if (!recipient) return null
      return {
        ...inline,
        to: recipient,
        subject: `[Family Events] New invite request from ${payload.email}`,
        html: `<h1>New Invite Request</h1><p>${escape(payload.email)}</p>${payload.message ? `<p>${escape(payload.message)}</p>` : ""}<p><a href="${escape(new URL("/admin/invites", origin).toString())}">Review invitation request</a></p>`,
      }
    }
    if (row.kind === "request_approved")
      return {
        ...inline,
        subject: "Your Family Events invite code",
        html: `<h1>Your invitation is approved</h1><p>Thanks for asking to join Family Events. Here is your invitation code:</p><p><strong>${escape(payload.code ?? "")}</strong></p><p><a href="${escape(new URL("/onboarding", origin).toString())}">Create an account or sign in, then redeem your code</a></p>`,
      }
    return {
      ...inline,
      subject: "Update on your Family Events invite request",
      html: "<h1>Invitation request update</h1><p>Thanks for your interest in Family Events. We are unable to approve your invitation request at this time.</p>",
    }
  }
  async handleJob(data: object, signal?: AbortSignal): Promise<void> {
    if (!this.enabled()) throw new Error("transactional email ownership is disabled")
    if (!("task" in data) || data.task !== "process")
      throw new Error("unknown transactional email task")
    for (let count = 0; count < 10; count++) {
      signal?.throwIfAborted()
      const row = await this.db.withTransaction(async (client) => {
        const pending = await client.query<Entry>(`SELECT * FROM private.transactional_email_outbox
     WHERE (status='pending' AND next_attempt_at<=now()) OR (status='processing' AND locked_until<=now())
     ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)
        const item = pending.rows[0]
        if (!item) return null
        if (item.first_attempt_at) {
          const expired = await client.query<{ expired: boolean }>(
            "SELECT $1::timestamptz<=now()-interval '23 hours' AS expired",
            [item.first_attempt_at]
          )
          if (expired.rows[0]?.expired) {
            await client.query(
              "UPDATE private.transactional_email_outbox SET status='needs_review',locked_until=NULL,last_error='idempotency_window_expired',updated_at=now() WHERE id=$1",
              [item.id]
            )
            return { skip: true as const }
          }
        }
        if (
          item.kind === "welcome" ||
          item.kind === "community_event_approved" ||
          item.kind === "community_event_rejected"
        ) {
          const active =
            item.kind === "welcome"
              ? await client.query(
                  "SELECT clerk_user_id FROM public.clerk_user_mapping WHERE supabase_uuid=$1",
                  [item.target_id]
                )
              : await client.query(
                  `SELECT id FROM auth.users WHERE id=$1 AND email IS NOT NULL
                AND NOT EXISTS(SELECT FROM private.clerk_user_lifecycle WHERE storage_uuid=$1 AND deleted_at IS NOT NULL)
                AND NOT EXISTS(SELECT FROM private.account_deletions WHERE user_id=$1)`,
                  [item.target_id]
                )
          if (!active.rows.length) {
            await client.query(
              "UPDATE private.transactional_email_outbox SET status='cancelled',payload=NULL,delivery=NULL,locked_until=NULL,last_error='account_deleted',updated_at=now() WHERE id=$1",
              [item.id]
            )
            return { skip: true as const }
          }
        }
        let delivery = item.delivery
        let reason: string | null = null
        if (!this.config.get("RESEND_API_KEY", { infer: true })) reason = "provider_not_configured"
        if (!reason && !delivery) {
          try {
            delivery = this.render(item)
            if (!delivery) reason = "recipient_not_configured"
          } catch {
            reason = "invalid_payload"
          }
        }
        if (reason) {
          await client.query(
            "UPDATE private.transactional_email_outbox SET status=$2,next_attempt_at=now()+interval '1 minute',locked_until=NULL,last_error=$3,updated_at=now() WHERE id=$1",
            [item.id, reason === "invalid_payload" ? "failed" : "pending", reason]
          )
          return { skip: true as const }
        }
        const claimed = await client.query<{ delivery: Delivery }>(
          `UPDATE private.transactional_email_outbox SET status='processing',delivery=$2::jsonb,
      first_attempt_at=coalesce(first_attempt_at,now()),locked_until=now()+interval '1 minute',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING delivery`,
          [item.id, JSON.stringify(delivery)]
        )
        return { skip: false as const, item, delivery: claimed.rows[0]!.delivery }
      })
      if (!row) break
      if (row.skip) continue
      const result = await this.mail.send({
        ...row.delivery,
        idempotencyKey: `family-events-transactional-${row.item.id}`,
        signal,
      })
      signal?.throwIfAborted()
      if (result.sent) {
        await this.db.query(
          `UPDATE private.transactional_email_outbox SET status='sent',sent_at=now(),provider_id=$2,
      payload=NULL,delivery=NULL,locked_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND attempts=$3`,
          [row.item.id, result.providerId ?? null, row.item.attempts + 1]
        )
      } else {
        const permanent =
          result.status !== undefined &&
          result.status >= 400 &&
          result.status < 500 &&
          result.status !== 409 &&
          result.status !== 429
        const delay = Math.min(3600, 30 * 2 ** Math.min(row.item.attempts, 7))
        await this.db.query(
          `UPDATE private.transactional_email_outbox SET status=$2,next_attempt_at=now()+($3::integer*interval '1 second'),
      locked_until=NULL,last_error=$4,updated_at=now() WHERE id=$1 AND status='processing' AND attempts=$5`,
          [
            row.item.id,
            permanent ? "failed" : "pending",
            delay,
            result.dev
              ? "provider_not_configured"
              : result.status
                ? `provider_${result.status}`
                : "provider_unavailable",
            row.item.attempts + 1,
          ]
        )
      }
    }
  }
  private async admin<T>(actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await withAdminActor(this.db, actor, async (client) => {
        await requireDatabaseAdmin(client)
        return work(client)
      })
    } catch (error) {
      if (isDatabaseAdminDenial(error))
        throw new ForbiddenException("admin access is not provisioned")
      if (error instanceof HttpException) throw error
      throw new ServiceUnavailableException("Email delivery status is unavailable")
    }
  }
  async list(actor: string) {
    return this.admin(
      actor,
      async (client) =>
        (
          await client.query(
            `SELECT id,kind,target_id,status,attempts,next_attempt_at,first_attempt_at,sent_at,last_error,created_at,updated_at FROM private.transactional_email_outbox ORDER BY created_at DESC,id LIMIT 100`
          )
        ).rows
    )
  }
  async readiness(actor: string) {
    return this.admin(actor, async () => ({
      worker_enabled: this.enabled(),
      provider_configured: Boolean(this.config.get("RESEND_API_KEY", { infer: true })),
      admin_recipient_configured: Boolean(this.config.get("ADMIN_NOTIFY_EMAIL", { infer: true })),
    }))
  }
  async retry(actor: string, id: string) {
    const result = await this.admin(actor, async (client) => {
      const row = await client.query<{ status: string; expired: boolean }>(
        "SELECT status,first_attempt_at<=now()-interval '23 hours' AS expired FROM private.transactional_email_outbox WHERE id=$1 FOR UPDATE",
        [id]
      )
      if (!row.rows[0] || !["pending", "failed"].includes(row.rows[0].status))
        throw new NotFoundException()
      if (row.rows[0].expired) {
        await client.query(
          "UPDATE private.transactional_email_outbox SET status='needs_review',last_error='idempotency_window_expired',updated_at=now() WHERE id=$1",
          [id]
        )
        return false
      }
      await client.query(
        "UPDATE private.transactional_email_outbox SET status='pending',next_attempt_at=now(),locked_until=NULL,updated_at=now() WHERE id=$1",
        [id]
      )
      await client.query(
        `INSERT INTO public.admin_audit_log(admin_user_id,action,target_type,target_id,metadata)
     VALUES(auth.uid(),'transactional_email.retry','transactional_email',$1,'{}'::jsonb)`,
        [id]
      )
      return true
    })
    if (!result)
      throw new ConflictException(
        "Provider idempotency window expired. Delivery requires operator reconciliation."
      )
    return { ok: true as const }
  }
}
