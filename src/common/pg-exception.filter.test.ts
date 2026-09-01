import { ArgumentsHost, type HttpServer } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { PgExceptionFilter } from "./pg-exception.filter.js"

function makeHost(): {
  host: ArgumentsHost
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
} {
  const status = vi.fn().mockReturnThis()
  const json = vi.fn()
  const response = { status, json }
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
    getArgByIndex: (index: number) => (index === 1 ? response : {}),
  } as unknown as ArgumentsHost
  return { host, status, json }
}

function httpServerStub(): HttpServer {
  return {
    isHeadersSent: () => false,
    reply: (
      res: { status: (code: number) => { json: (body: unknown) => void } },
      body: unknown,
      statusCode: number
    ) => res.status(statusCode).json(body),
  } as unknown as HttpServer
}

function pgError(code: string): Error {
  return Object.assign(new Error(`pg error ${code}`), { code })
}

describe("PgExceptionFilter", () => {
  it("maps an FK violation (23503) to 404", () => {
    const { host, status, json } = makeHost()
    new PgExceptionFilter().catch(pgError("23503"), host)
    expect(status).toHaveBeenCalledWith(404)
    expect(json).toHaveBeenCalledWith({
      statusCode: 404,
      message: "related record not found",
      error: "Not Found",
    })
  })

  it("maps a unique violation (23505) to 409", () => {
    const { host, status, json } = makeHost()
    new PgExceptionFilter().catch(pgError("23505"), host)
    expect(status).toHaveBeenCalledWith(409)
    expect(json).toHaveBeenCalledWith({
      statusCode: 409,
      message: "record already exists",
      error: "Conflict",
    })
  })

  it("maps invalid text representation (22P02) to 400", () => {
    const { host, status, json } = makeHost()
    new PgExceptionFilter().catch(pgError("22P02"), host)
    expect(status).toHaveBeenCalledWith(400)
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      message: "invalid identifier",
      error: "Bad Request",
    })
  })

  it("delegates everything else to the base filter", () => {
    const { host, status } = makeHost()
    const boom = new Error("totally unknown")
    new PgExceptionFilter(httpServerStub()).catch(boom, host)
    expect(status).toHaveBeenCalledWith(500)
  })
})
