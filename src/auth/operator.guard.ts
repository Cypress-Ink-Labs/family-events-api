import {
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common"

import type { IdentifiedRequest } from "./mapped-identity.guard.js"

/**
 * Requires MappedIdentityGuard earlier in the chain. Gates the admin surface
 * (U31). Non-operators get 404, not 403 (U9 / requireOperatorIdentity).
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IdentifiedRequest>()
    if (request.identity.role !== "operator") {
      throw new NotFoundException()
    }
    return true
  }
}
