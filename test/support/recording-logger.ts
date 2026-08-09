import type { Logger, LogMeta } from "../../src/shared/logging/logger";

export type CapturedLog = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta: LogMeta;
};

/**
 * Logger de test que registra cada linea con los bindings de `child()`
 * ya fusionados (Etapa 9: verificar correlationId end-to-end).
 * Todas las instancias hijas comparten el mismo array `lines`.
 */
export class RecordingLogger implements Logger {
  constructor(
    readonly lines: CapturedLog[],
    private readonly bindings: LogMeta = {},
  ) {}

  child(bindings: LogMeta): Logger {
    return new RecordingLogger(this.lines, { ...this.bindings, ...bindings });
  }

  debug(metaOrMessage: LogMeta | string, message?: string): void {
    this.capture("debug", metaOrMessage, message);
  }

  info(metaOrMessage: LogMeta | string, message?: string): void {
    this.capture("info", metaOrMessage, message);
  }

  warn(metaOrMessage: LogMeta | string, message?: string): void {
    this.capture("warn", metaOrMessage, message);
  }

  error(metaOrMessage: LogMeta | string, message?: string): void {
    this.capture("error", metaOrMessage, message);
  }

  linesWithCorrelation(correlationId: string): CapturedLog[] {
    return this.lines.filter((line) => line.meta.correlationId === correlationId);
  }

  private capture(level: CapturedLog["level"], metaOrMessage: LogMeta | string, message?: string): void {
    if (typeof metaOrMessage === "string") {
      this.lines.push({ level, message: metaOrMessage, meta: { ...this.bindings } });
      return;
    }
    this.lines.push({
      level,
      message: message ?? "",
      meta: { ...this.bindings, ...metaOrMessage },
    });
  }
}

export function createRecordingLogger(): RecordingLogger {
  return new RecordingLogger([]);
}
