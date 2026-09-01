import "reflect-metadata"

import { ValidationPipe } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { NestFactory } from "@nestjs/core"
import { SwaggerModule } from "@nestjs/swagger"

import { AppModule } from "./app.module.js"
import { PgExceptionFilter } from "./common/pg-exception.filter.js"
import type { Env } from "./config/env.js"
import { buildOpenApiDocument } from "./openapi.js"

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  // The adapter reference is required so BaseExceptionFilter can answer the
  // errors this filter does not map itself; Nest does not inject httpAdapterHost
  // into filter instances constructed with `new`.
  app.useGlobalFilters(new PgExceptionFilter(app.getHttpAdapter()))
  app.enableShutdownHooks()
  SwaggerModule.setup("docs", app, buildOpenApiDocument(app))
  const config = app.get(ConfigService<Env, true>)
  await app.listen(config.get("PORT", { infer: true }))
}

void bootstrap()
