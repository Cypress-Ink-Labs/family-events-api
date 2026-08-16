import { Module } from "@nestjs/common"

import { ClerkAuthGuard } from "./clerk.guard.js"
import { IdentityService } from "./identity.service.js"
import { MappedIdentityGuard } from "./mapped-identity.guard.js"
import { OperatorGuard } from "./operator.guard.js"
import { OptionalClerkAuthGuard } from "./optional-clerk.guard.js"

const AUTH_PROVIDERS = [
  ClerkAuthGuard,
  IdentityService,
  MappedIdentityGuard,
  OperatorGuard,
  OptionalClerkAuthGuard,
]

@Module({
  providers: AUTH_PROVIDERS,
  exports: AUTH_PROVIDERS,
})
export class AuthModule {}
