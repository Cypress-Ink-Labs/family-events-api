import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common"

import type { AuthenticatedRequest } from "./clerk.guard.js"
import { IdentityService, type MappedIdentity } from "./identity.service.js"

export interface IdentifiedRequest extends AuthenticatedRequest {
  identity: MappedIdentity
}

/**
 * Runs after ClerkAuthGuard. A verified but unprovisioned Clerk user is
 * forbidden: pre-cutover, only users written to clerk_user_mapping by the
 * U19 provisioning script have any data rows to act on.
 */
@Injectable()
export class MappedIdentityGuard implements CanActivate {
  constructor(private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdentifiedRequest>()
    const mapped = await this.identity.resolve(request.user.clerkUserId)
    if (mapped === null) {
      throw new ForbiddenException("user is not provisioned")
    }
    request.identity = mapped
    return true
  }
}
