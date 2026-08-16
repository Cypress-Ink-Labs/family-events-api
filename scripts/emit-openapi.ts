import "./openapi-env.js"

import "reflect-metadata"

import { writeFileSync } from "node:fs"

import { NestFactory } from "@nestjs/core"

import { AppModule } from "../src/app.module.js"
import { buildOpenApiDocument } from "../src/openapi.js"

/**
 * Emits openapi.json without starting the HTTP listener or pg-boss.
 * The web app generates its typed client from this file.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false })
  await app.init()
  const document = buildOpenApiDocument(app)
  writeFileSync("openapi.json", `${JSON.stringify(document, null, 2)}\n`)
  await app.close()
  console.log("wrote openapi.json")
}

main().catch((error: unknown) => {
  console.error("failed to emit openapi.json:", error)
  process.exitCode = 1
})
