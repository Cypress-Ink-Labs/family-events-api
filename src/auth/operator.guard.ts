import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common"

import type { IdentifiedRequest } from "./mapped-identity.guard.js"

/** Requires MappedIdentityGuard earlier in the chain. Gates admin surface (U31). */
@Injectable()
export class OperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IdentifiedRequest>()
    if (request.identity.role !== "operator") {
      throw new ForbiddenException("operator role required")
    }
    return true
  }
}
