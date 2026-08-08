import type { Logger, LogMeta } from "./logger.port";

type Level = "debug" | "info" | "warn" | "error";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
} as const;

const LEVEL_COLOR: Record<Level, string> = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
};

/** Color de etiqueta por `module` / ambito del flujo. */
function scopeColor(scope: string): string {
  switch (scope) {
    case "http":
      return ANSI.blue;
    case "conversations":
    case "whatsapp":
      return ANSI.green;
    case "ingestion":
      return ANSI.magenta;
    case "cases":
      return ANSI.yellow;
    case "n8n":
      return ANSI.cyan;
    default:
      return ANSI.white;
  }
}

function shortId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= 8 ? value : value.slice(0, 8);
}

/**
 * Logger de desarrollo con colores por nivel y por modulo.
 * Implementa el puerto `Logger` (Dependency Inversion) — en produccion
 * se usa `PinoLoggerAdapter` (JSON estructurado).
 */
export class ColoredConsoleLogger implements Logger {
  constructor(private readonly bindings: LogMeta = {}) {}

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
    return new ColoredConsoleLogger({ ...this.bindings, ...bindings });
  }

  private write(level: Level, metaOrMessage: LogMeta | string, message?: string): void {
    const meta =
      typeof metaOrMessage === "string"
        ? {}
        : { ...this.bindings, ...metaOrMessage };
    const msg =
      typeof metaOrMessage === "string" ? metaOrMessage : (message ?? "");

    const scope = String(meta.module ?? meta.scope ?? "app");
    const corr = shortId(meta.correlationId);
    const time = new Date().toISOString().slice(11, 23);

    const levelTag = `${LEVEL_COLOR[level]}${level.toUpperCase().padEnd(5)}${ANSI.reset}`;
    const scopeTag = `${scopeColor(scope)}${ANSI.bold}[${scope}]${ANSI.reset}`;
    const corrTag = corr ? `${ANSI.dim}corr=${corr}${ANSI.reset} ` : "";

    const interestingKeys = [
      "method",
      "path",
      "status",
      "durationMs",
      "waPhone",
      "body",
      "conversationId",
      "messageId",
      "isDuplicate",
      "messageCount",
      "decision",
      "intent",
      "interpretationType",
      "action",
      "caseId",
    ];
    const details: string[] = [];
    for (const key of interestingKeys) {
      if (meta[key] === undefined || meta[key] === null) continue;
      let value = meta[key];
      if (key === "conversationId" || key === "messageId" || key === "caseId") {
        value = shortId(value) ?? value;
      }
      if (key === "body" && typeof value === "string" && value.length > 100) {
        value = `${value.slice(0, 97)}...`;
      }
      details.push(`${key}=${JSON.stringify(value)}`);
    }

    const detailStr =
      details.length > 0 ? ` ${ANSI.dim}${details.join(" ")}${ANSI.reset}` : "";

    // Escritura sincrona: visible con `tsx watch` (a diferencia de pino async).
    console.log(
      `${ANSI.gray}${time}${ANSI.reset} ${levelTag} ${scopeTag} ${corrTag}${msg}${detailStr}`,
    );
  }
}
