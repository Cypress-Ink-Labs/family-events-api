import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Req,
  ServiceUnavailableException,
  type RawBodyRequest,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger"
import { verifyWebhook } from "@clerk/backend/webhooks"
import type { Request as ExpressRequest } from "express"

import { ClerkLifecycleService } from "./clerk-lifecycle.service.js"

import type { Env } from "../config/env.js"

@ApiTags("identity")
@Controller("webhooks/clerk")
export class ClerkLifecycleController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly lifecycle: ClerkLifecycleService
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    operationId: "clerkLifecycleWebhook",
    summary: "Apply a signed Clerk lifecycle delivery",
  })
  @ApiHeader({ name: "svix-id", required: true })
  @ApiHeader({ name: "svix-timestamp", required: true })
  @ApiHeader({ name: "svix-signature", required: true })
  @ApiBody({
    schema: {
      type: "object",
      required: ["type", "data"],
      properties: {
        type: { type: "string" },
        data: { type: "object", additionalProperties: true },
      },
    },
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean", enum: [true] } },
    },
  })
  @ApiResponse({
    status: 400,
    description: "Invalid signature, expired delivery, or malformed lifecycle identity",
  })
  @ApiResponse({ status: 409, description: "Identity binding conflicts with historical ownership" })
  @ApiResponse({
    status: 503,
    description: "Configuration, provider, or storage failure; retry delivery",
  })
  async receive(@Req() request: RawBodyRequest<ExpressRequest>): Promise<{ ok: boolean }> {
    const signingSecret = this.config.get("CLERK_WEBHOOK_SIGNING_SECRET", { infer: true })
    if (!signingSecret) throw new ServiceUnavailableException("webhook not configured")
    if (!request.rawBody) throw new BadRequestException("missing raw body")
    const headers = new Headers()
    for (const name of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const value = request.headers[name]
      if (typeof value === "string") headers.set(name, value)
    }
    let event
    try {
      event = await verifyWebhook(
        new Request("http://localhost/webhooks/clerk", {
          method: "POST",
          headers,
          body: request.rawBody.toString("utf8"),
        }),
        { signingSecret }
      )
    } catch {
      throw new BadRequestException("invalid webhook signature")
    }
    if (
      event.type === "user.created" ||
      event.type === "user.updated" ||
      event.type === "user.deleted"
    ) {
      const data: unknown = event.data
      const id = typeof data === "object" && data !== null && "id" in data ? data.id : undefined
      if (typeof id !== "string" || !/^user_[a-zA-Z0-9]+$/.test(id))
        throw new BadRequestException("invalid lifecycle identity")
      try {
        await this.lifecycle.apply(event.type, id)
      } catch (error) {
        if (error instanceof HttpException) throw error
        throw new ServiceUnavailableException("lifecycle could not be applied")
      }
    }
    return { ok: true }
  }
}
