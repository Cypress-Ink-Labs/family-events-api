import {
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { verifyToken } from "@clerk/backend"
import type { Request } from "express"

import type { Env } from "../config/env.js"

export interface AuthenticatedUser {
  clerkUserId: string
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser
}

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly logger = new Logger(ClerkAuthGuard.name)

  constructor(private readonly config: ConfigService<Env, true>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const header = request.headers.authorization
    if (header === undefined || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer token")
    }
    const secretKey = this.config.get("CLERK_SECRET_KEY", { infer: true })
    if (secretKey === undefined) {
      // Fail closed: an instance without Clerk configured serves no authenticated routes.
      this.logger.warn("CLERK_SECRET_KEY not configured; rejecting authenticated request")
      throw new UnauthorizedException("authentication not configured")
    }
    try {
      const payload = await verifyToken(header.slice("Bearer ".length), { secretKey })
      request.user = { clerkUserId: payload.sub }
      return true
    } catch {
      throw new UnauthorizedException("invalid token")
    }
  }
}
