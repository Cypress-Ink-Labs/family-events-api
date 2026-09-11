import { Global, MiddlewareConsumer, Module, type NestModule } from "@nestjs/common"

import { RequestLoggingMiddleware } from "./request-logging.middleware.js"
import { consoleStructuredLogSink, STRUCTURED_LOG_SINK } from "./structured-log.js"

@Global()
@Module({
  providers: [
    RequestLoggingMiddleware,
    { provide: STRUCTURED_LOG_SINK, useValue: consoleStructuredLogSink },
  ],
  exports: [STRUCTURED_LOG_SINK],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggingMiddleware).forRoutes("*")
  }
}
