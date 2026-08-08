import pino from "pino";
import type { Env } from "../config/env";

/**
 * Logger estructurado (AGENTS.md: "Logging estructurado con correlationId
 * propagado end-to-end"). `child({ correlationId })` se usa en cada request
 * y en cada paso de negocio (mensaje → caso → ejecucion → resultado) para
 * que todas las lineas de una misma cadena causal compartan el mismo id.
 */
export function createLogger(env: Env): pino.Logger {
  return pino({
    level: env.NODE_ENV === "test" ? "silent" : "info",
    base: undefined,
  });
}

export type Logger = pino.Logger;

export function withCorrelationId(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}
