import type { ErrorRequestHandler } from "express";
import { DomainError } from "../../errors/domain-errors";
import type { Logger } from "../../logging/logger";

const STATUS_BY_ERROR_TYPE: Record<DomainError["type"], number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  BUSINESS_ERROR: 409,
  UNSUPPORTED: 422,
  TIMEOUT: 504,
  EXTERNAL_SERVICE_ERROR: 502,
  AI_ERROR: 502,
};

/**
 * Unico formato de error HTTP de todo el API (docs/skills/api-design-best-practices.md).
 * Debe montarse al final de la cadena de middlewares.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof DomainError) {
      logger.warn({ err, path: req.path }, "domain error");
      res.status(STATUS_BY_ERROR_TYPE[err.type]).json({
        error: { type: err.type, message: err.message },
      });
      return;
    }

    logger.error({ err, path: req.path }, "unhandled error");
    res.status(500).json({
      error: { type: "EXTERNAL_SERVICE_ERROR", message: "Error interno inesperado" },
    });
  };
}
