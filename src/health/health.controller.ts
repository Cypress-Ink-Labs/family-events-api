import { Controller, Get, ServiceUnavailableException } from "@nestjs/common"
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"

import { DbService } from "../db/db.service.js"

class HealthResponse {
  status!: "ok"
}

@ApiTags("health")
@Controller()
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get("healthz")
  @ApiOperation({ summary: "Liveness probe" })
  @ApiOkResponse({ type: HealthResponse })
  healthz(): HealthResponse {
    return { status: "ok" }
  }

  @Get("readyz")
  @ApiOperation({ summary: "Readiness probe (verifies database connectivity)" })
  @ApiOkResponse({ type: HealthResponse })
  async readyz(): Promise<HealthResponse> {
    if (!(await this.db.ping())) {
      throw new ServiceUnavailableException("database unreachable")
    }
    return { status: "ok" }
  }
}
