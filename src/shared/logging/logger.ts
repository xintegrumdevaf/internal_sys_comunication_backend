export type { Logger, LogMeta } from "./logger.port";
export { createLogger } from "./pino-logger.adapter";
export { ColoredConsoleLogger } from "./colored-console.logger";
export { PinoLoggerAdapter } from "./pino-logger.adapter";

import type { Logger } from "./logger.port";

/**
 * `child({ correlationId })` se usa en cada request y en cada paso de negocio
 * (mensaje → caso → ejecucion → resultado) para que todas las lineas de una
 * misma cadena causal compartan el mismo id (AGENTS.md).
 */
export function withCorrelationId(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}
