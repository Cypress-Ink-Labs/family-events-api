import { BadRequestException, Controller, Get, Query, Req, UseGuards } from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import { z } from "zod"
import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { NextPlanDto, NextPlanQueryDto } from "./next-plan.dto.js"
import { NextPlanService } from "./next-plan.service.js"

const querySchema = z
  .strictObject({
    city_id: z.uuid().optional(),
    kid_age: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(18))
      .optional(),
    lat: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/)
      .transform(Number)
      .pipe(z.number().min(-90).max(90))
      .optional(),
    lng: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/)
      .transform(Number)
      .pipe(z.number().min(-180).max(180))
      .optional(),
  })
  .refine((value) => (value.lat === undefined) === (value.lng === undefined))

@ApiTags("consumer")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "A valid Clerk session is required" })
@ApiForbiddenResponse({ description: "Enabled account access is required" })
@ApiBadRequestResponse({ description: "Invalid planner preferences or coordinates" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard)
@Controller("v1/plan/next")
export class NextPlanController {
  constructor(private readonly plans: NextPlanService) {}

  @Get()
  @ApiOperation({
    operationId: "getMyNextPlan",
    summary: "Find the first nonempty personal plan from today through day seven",
  })
  @ApiQuery({ type: NextPlanQueryDto })
  @ApiOkResponse({ type: NextPlanDto })
  next(
    @Req() request: IdentifiedRequest,
    @Query() query: Record<string, unknown>
  ): Promise<NextPlanDto> {
    const result = querySchema.safeParse(query)
    if (!result.success) throw new BadRequestException("Invalid planner inputs")
    return this.plans.next(request.identity.supabaseUuid, {
      cityId: result.data.city_id,
      kidAge: result.data.kid_age,
      lat: result.data.lat,
      lng: result.data.lng,
    })
  }
}
