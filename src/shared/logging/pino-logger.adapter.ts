import pino from "pino";
import type { Env } from "../config/env";
import type { Logger, LogMeta } from "./logger.port";

type Level = "debug" | "info" | "warn" | "error";

/** Adapter concreto del puerto `Logger` sobre Pino (docs/skills/hexagonal-architecture.md). */
export class PinoLoggerAdapter implements Logger {
  constructor(private readonly pinoLogger: pino.Logger) {}

  debug(metaOrMessage: LogMeta | string, message?: string): void {
    this.write("debug", metaOrMessage, message);
  }

  info(metaOrMessage: LogMeta | string, message?: string): void {
    this.write("info", metaOrMessage, message);
  }

  warn(metaOrMessage: LogMeta | string, message?: string): void {
    this.write("warn", metaOrMessage, message);
  }

  error(metaOrMessage: LogMeta | string, message?: string): void {
    this.write("error", metaOrMessage, message);
  }

  child(bindings: LogMeta): Logger {
    return new PinoLoggerAdapter(this.pinoLogger.child(bindings));
  }

  private write(level: Level, metaOrMessage: LogMeta | string, message?: string): void {
    if (typeof metaOrMessage === "string") {
      this.pinoLogger[level](metaOrMessage);
      return;
    }
    this.pinoLogger[level](metaOrMessage, message);
  }
}

/**
 * Fabrica del logger raiz de la aplicacion (AGENTS.md: "Logging estructurado
 * con correlationId propagado end-to-end"). Unico lugar donde se construye
 * un `pino.Logger` concreto — todo lo demas depende del puerto `Logger`.
 */
export function createLogger(env: Env): Logger {
  const pinoLogger = pino({
    level: env.NODE_ENV === "test" ? "silent" : "info",
    base: undefined,
  });
  return new PinoLoggerAdapter(pinoLogger);
}
