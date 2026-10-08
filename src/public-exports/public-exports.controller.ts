import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger"
import { z } from "zod"
import {
  PublicEventDto,
  PublicEventEnvelopeDto,
  PublicEventsPageDto,
  PublicEventsQueryDto,
  SitemapEventDto,
} from "./public-exports.dto.js"
import { parsePublicEventsQuery } from "./public-exports.query.js"
import { PublicExportsRepository } from "./public-exports.repository.js"

@ApiTags("public-exports")
@Controller("v1")
export class PublicExportsController {
  constructor(private readonly exports: PublicExportsRepository) {}
  @Get("public-events")
  @ApiOperation({ summary: "Legacy public event collection", security: [] })
  @ApiQuery({ type: PublicEventsQueryDto })
  @ApiOkResponse({ type: PublicEventsPageDto })
  @ApiBadRequestResponse({ description: "Invalid public filter or cursor" })
  list(@Query() query: Record<string, unknown>) {
    return this.exports.list(parsePublicEventsQuery(query))
  }

  @Get("public-events/:id")
  @ApiOperation({ summary: "Legacy public event envelope", security: [] })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: PublicEventEnvelopeDto })
  @ApiNotFoundResponse({ description: "Event is missing or unpublished" })
  async event(@Param("id") id: string): Promise<PublicEventEnvelopeDto> {
    return { data: await this.exports.event(this.uuid(id)) }
  }

  @Get("public-exports/feed")
  @ApiOperation({ summary: "Upcoming published feed events, maximum 200", security: [] })
  @ApiQuery({ name: "city", required: false, format: "uuid" })
  @ApiOkResponse({ type: [PublicEventDto] })
  feed(@Query("city") city?: unknown) {
    return this.exports.feed(city === undefined ? null : this.uuid(city))
  }

  @Get("public-exports/sitemap")
  @ApiOperation({ summary: "Published sitemap entries, maximum 5000", security: [] })
  @ApiOkResponse({ type: [SitemapEventDto] })
  sitemap() {
    return this.exports.sitemap()
  }

  private uuid(value: unknown) {
    const result = z.uuid().safeParse(value)
    if (!result.success) throw new BadRequestException("invalid event or city id")
    return result.data
  }
}
