import { Module } from "@nestjs/common"

import { ClerkAuthGuard } from "./clerk.guard.js"
import { IdentityService } from "./identity.service.js"
import { MappedIdentityGuard } from "./mapped-identity.guard.js"
import { OperatorGuard } from "./operator.guard.js"

@Module({
  providers: [ClerkAuthGuard, IdentityService, MappedIdentityGuard, OperatorGuard],
  exports: [ClerkAuthGuard, IdentityService, MappedIdentityGuard, OperatorGuard],
})
export class AuthModule {}
