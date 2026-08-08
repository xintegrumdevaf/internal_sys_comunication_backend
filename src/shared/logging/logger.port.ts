export type LogMeta = Record<string, unknown>;

/**
 * Puerto de logging (docs/skills/solid-principles.md §D — Dependency Inversion):
 * `application/`/`domain/` dependen de esta interfaz, nunca de `pino` directamente.
 * Esto es lo que permite, por ejemplo, inyectar un `SilentLogger` en tests sin
 * arrastrar la libreria concreta (docs/skills/testing-strategy.md).
 */
export interface Logger {
  debug(meta: LogMeta, message: string): void;
  debug(message: string): void;
  info(meta: LogMeta, message: string): void;
  info(message: string): void;
  warn(meta: LogMeta, message: string): void;
  warn(message: string): void;
  error(meta: LogMeta, message: string): void;
  error(message: string): void;
  /** Crea un logger hijo que añade `bindings` a cada linea (AGENTS.md: correlationId end-to-end). */
  child(bindings: LogMeta): Logger;
}
