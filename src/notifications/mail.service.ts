import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"

const RESEND_ENDPOINT = "https://api.resend.com/emails"
const DEFAULT_FROM = "Family Events <onboarding@resend.dev>"

export interface SendMailInput {
  to: string
  subject: string
  html?: string
  templateId?: string
  variables?: Record<string, string>
}

export interface SendMailResult {
  sent: boolean
  dev?: boolean
  status?: number
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)

  constructor(private readonly config: ConfigService<Env, true>) {}

  async send(input: SendMailInput): Promise<SendMailResult> {
    if ((input.html === undefined) === (input.templateId === undefined)) {
      throw new Error("mail input must provide exactly one of html or templateId")
    }

    const apiKey = this.config.get("RESEND_API_KEY", { infer: true })
    if (!apiKey) {
      this.logger.warn(`RESEND_API_KEY not configured; skipped email to ${input.to}`)
      return { sent: false, dev: true }
    }

    const payload = {
      from: this.config.get("RESEND_FROM", { infer: true }) ?? DEFAULT_FROM,
      to: input.to,
      subject: input.subject,
      ...(input.templateId
        ? { template: { id: input.templateId, variables: input.variables ?? {} } }
        : { html: input.html }),
    }

    try {
      const response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, 300)
        this.logger.warn(`Resend rejected email to ${input.to}: ${response.status} ${body}`)
        return { sent: false, status: response.status }
      }
      return { sent: true, status: response.status }
    } catch (error) {
      this.logger.warn(
        `Resend delivery failed for ${input.to}: ${error instanceof Error ? error.message : String(error)}`
      )
      return { sent: false }
    }
  }
}
