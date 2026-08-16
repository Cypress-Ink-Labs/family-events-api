import { verifyToken } from "@clerk/backend"
import {
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type { Request } from "express"

import type { Env } from "../config/env.js"
import { IdentityService, type MappedIdentity } from "./identity.service.js"

export interface OptionalIdentifiedRequest extends Request {
  identity?: MappedIdentity
}

@Injectable()
export class OptionalClerkAuthGuard implements CanActivate {
  private readonly logger = new Logger(OptionalClerkAuthGuard.name)

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly identity: IdentityService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OptionalIdentifiedRequest>()
    const header = request.headers.authorization
    if (header === undefined) return true
    if (!header.startsWith("Bearer ") || header.length === "Bearer ".length) {
      throw new UnauthorizedException("invalid authorization header")
    }

    const secretKey = this.config.get("CLERK_SECRET_KEY", { infer: true })
    if (secretKey === undefined) {
      this.logger.warn("CLERK_SECRET_KEY not configured; rejecting authenticated request")
      throw new UnauthorizedException("authentication not configured")
    }

    let clerkUserId: string
    try {
      const payload = await verifyToken(header.slice("Bearer ".length), { secretKey })
      clerkUserId = payload.sub
    } catch {
      throw new UnauthorizedException("invalid token")
    }

    const mapped = await this.identity.resolve(clerkUserId)
    if (mapped !== null) request.identity = mapped
    return true
  }
}
