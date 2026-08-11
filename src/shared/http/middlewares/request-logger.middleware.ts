import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { withCorrelationId, type Logger } from "../../logging/logger";

/**
 * Asigna/propaga un correlationId por request (AGENTS.md: logging
 * estructurado con correlationId end-to-end). Si el llamador (n8n, un
 * proxy) ya trae uno, se reutiliza en vez de generar uno nuevo.
 */
export function createRequestLogger(logger: Logger) {
  const httpLogger = logger.child({ module: "http" });

  return (req: Request, res: Response, next: NextFunction): void => {
    const correlationId = (req.header("x-correlation-id") ?? randomUUID()).toString();
    const requestLogger = withCorrelationId(httpLogger, correlationId);
    req.correlationId = correlationId;
    req.log = requestLogger;
    res.setHeader("x-correlation-id", correlationId);

    requestLogger.info(
      { method: req.method, path: req.path },
      "request recibida",
    );

    const startedAt = Date.now();
    res.on("finish", () => {
      requestLogger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        },
        "request completada",
      );
    });

    next();
  };
}
