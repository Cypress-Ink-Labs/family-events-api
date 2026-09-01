import { Catch, HttpException, HttpStatus, Logger } from "@nestjs/common"
import type { ArgumentsHost } from "@nestjs/common"
import { BaseExceptionFilter } from "@nestjs/core"
import type { Response } from "express"

interface MappedStatus {
  status: number
  message: string
}

// Postgres error codes that carry user-facing meaning. The pool connects with
// an RLS-exempt role, so violations that Supabase's PostgREST would have
// mapped (missing row, duplicate, bad enum text) land here instead.
const PG_ERROR_RESPONSE: Record<string, MappedStatus> = {
  "23503": { status: HttpStatus.NOT_FOUND, message: "related record not found" },
  "23505": { status: HttpStatus.CONFLICT, message: "record already exists" },
  "23502": { status: HttpStatus.BAD_REQUEST, message: "missing required value" },
  "23514": { status: HttpStatus.BAD_REQUEST, message: "invalid value" },
  "22P02": { status: HttpStatus.BAD_REQUEST, message: "invalid identifier" },
}

@Catch()
export class PgExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(PgExceptionFilter.name)

  override catch(exception: unknown, host: ArgumentsHost): void {
    const code = (exception as { code?: string } | null)?.code
    const mapped = code === undefined ? undefined : PG_ERROR_RESPONSE[code]
    if (mapped !== undefined) {
      const response = host.switchToHttp().getResponse<Response>()
      response.status(mapped.status).json({ statusCode: mapped.status, message: mapped.message })
      return
    }
    if (!(exception instanceof HttpException)) {
      this.logger.error(
        `Unhandled error: ${exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)}`
      )
    }
    super.catch(exception, host)
  }
}
