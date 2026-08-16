import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger"
import type { INestApplication } from "@nestjs/common"

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("family-events-api")
    .setDescription(
      "Backend API for the Family Events platform. " +
        "This OpenAPI document is the contract; the web app consumes a client generated from it."
    )
    .setVersion("0.1.0")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" }, "clerk")
    .build()
  return SwaggerModule.createDocument(app, config)
}
