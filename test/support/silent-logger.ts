import type { Logger, LogMeta } from "../../src/shared/logging/logger";

/**
 * Implementacion nula del puerto `Logger` (docs/skills/testing-strategy.md):
 * satisface la dependencia sin escribir nada ni arrastrar Pino, para tests
 * unitarios/integracion que no verifican logging.
 */
export class SilentLogger implements Logger {
  debug(_metaOrMessage?: LogMeta | string, _message?: string): void {}
  info(_metaOrMessage?: LogMeta | string, _message?: string): void {}
  warn(_metaOrMessage?: LogMeta | string, _message?: string): void {}
  error(_metaOrMessage?: LogMeta | string, _message?: string): void {}

  child(): Logger {
    return this;
  }
}

export const silentLogger: Logger = new SilentLogger();
