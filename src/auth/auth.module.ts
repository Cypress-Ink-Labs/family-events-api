import { Module } from "@nestjs/common"

import { ClerkAuthGuard } from "./clerk.guard.js"
import { IdentityService } from "./identity.service.js"
import { MappedIdentityGuard } from "./mapped-identity.guard.js"
import { OperatorGuard } from "./operator.guard.js"
import { OptionalClerkAuthGuard } from "./optional-clerk.guard.js"

@Module({
  providers: [
    ClerkAuthGuard,
    IdentityService,
    MappedIdentityGuard,
    OperatorGuard,
    OptionalClerkAuthGuard,
  ],
  exports: [
    ClerkAuthGuard,
    IdentityService,
    MappedIdentityGuard,
    OperatorGuard,
    OptionalClerkAuthGuard,
  ],
})
export class AuthModule {}
