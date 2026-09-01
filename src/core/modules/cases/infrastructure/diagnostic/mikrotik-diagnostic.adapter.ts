import type { Logger } from "../../../../../shared/logging/logger";
import { sanitizeForPostgresJson } from "../../../../../shared/db/sanitize-json";
import type { ExecuteActionParams, N8nActionResult, N8nGatewayPort } from "../../application/ports/n8n-gateway.port";

export type MikrotikDiagnosticAdapterConfig = {
  baseUrl: string;
  timeoutMs?: number;
  logger: Logger;
};

/**
 * Catalogo de endpoints de la API interna de MikroTik / OLT (`internal_sys_api_mikrotik`).
 * La base URL se inyecta desde `MIKROTIK_SERVICE_URL` (ej. "http://localhost:3001/api")
 * y este catalogo mapea las rutas relativas para cada accion del microservicio.
 */
export const MIKROTIK_API_PATHS = {
  DIAGNOSTIC: "/v1/diagnostic",
  CONTINUE_DIAGNOSTIC: "/v1/diagnostic/continue",
  CLIENT_STATUS: "/v1/mikrotik/client-status",
} as const;

/**
 * Adapter HTTP directo hacia el microservicio de diagnostico MikroTik / OLT
 * (`internal_sys_api_mikrotik`).
 *
 * Evita el intermediario de n8n para acciones de diagnostico tecnico critico,
 * reduciendo saltos de red, latencia y puntos de fallo unico, mientras
 * mantiene el contrato `N8nActionResult` compatible con el motor de casos.
 */
export class MikrotikDiagnosticAdapter implements N8nGatewayPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(config: MikrotikDiagnosticAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 35000;
    this.logger = config.logger;
  }

  async executeAction(params: ExecuteActionParams): Promise<N8nActionResult> {
    const log = this.logger.child({
      correlationId: params.correlationId,
      action: params.action,
      caseId: params.caseId,
      conversationId: params.conversationId,
    });

    if (params.action === "DIAGNOSTIC") {
      return this.executeInitialDiagnostic(params, log);
    }

    if (params.action === "CONTINUE_DIAGNOSTIC") {
      return this.executeContinueDiagnostic(params, log);
    }

    if (params.action === "CHECK_CLIENT_STATUS" || params.action === "CLIENT_STATUS") {
      return this.executeClientStatus(params, log);
    }

    return {
      success: false,
      error: {
        type: "UNSUPPORTED",
        message: `MikrotikDiagnosticAdapter no soporta la accion '${params.action}'`,
        retryable: false,
      },
    };
  }

  private async executeClientStatus(
    params: ExecuteActionParams,
    log: Logger,
  ): Promise<N8nActionResult> {
    const url = this.buildUrl(MIKROTIK_API_PATHS.CLIENT_STATUS);
    const body = {
      sector: params.input.sector ?? null,
      ip: params.input.ip ?? null,
    };

    return this.postJson(url, body, params.action, log);
  }

  private buildUrl(path: string): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${cleanPath}`;
  }

  private async executeInitialDiagnostic(
    params: ExecuteActionParams,
    log: Logger,
  ): Promise<N8nActionResult> {
    const url = this.buildUrl(MIKROTIK_API_PATHS.DIAGNOSTIC);
    const body = {
      sector: params.input.sector ?? null,
      oltName: params.input.oltName ?? null,
      pon: params.input.pon ?? null,
      serial: params.input.serial ?? null,
      conversationId: params.conversationId,
    };

    return this.postJson(url, body, params.action, log);
  }

  private async executeContinueDiagnostic(
    params: ExecuteActionParams,
    log: Logger,
  ): Promise<N8nActionResult> {
    const url = this.buildUrl(MIKROTIK_API_PATHS.CONTINUE_DIAGNOSTIC);
    const body = {
      conversationId: params.conversationId,
      message: params.input.message ?? "",
    };

    return this.postJson(url, body, params.action, log);
  }

  private async postJson(
    url: string,
    body: Record<string, unknown>,
    action: string,
    log: Logger,
  ): Promise<N8nActionResult> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    const start = Date.now();

    try {
      log.info({ url, body, timeoutMs: this.timeoutMs }, `[diagnostic-api] enviando peticion a '${action}'`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const elapsedMs = Date.now() - start;

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        log.error(
          { status: response.status, elapsedMs, body: errorText },
          `[diagnostic-api] respuesta HTTP no exitosa para '${action}'`,
        );

        const isValidation = response.status >= 400 && response.status < 500 && response.status !== 408;
        return {
          success: false,
          error: {
            type: isValidation ? "VALIDATION_ERROR" : "EXTERNAL_SERVICE_ERROR",
            message: `Servicio de diagnostico respondio ${response.status}: ${errorText.slice(0, 150)}`,
            retryable: !isValidation,
          },
        };
      }

      const rawText = await response.text();
      let parsedData: unknown;
      try {
        parsedData = JSON.parse(rawText);
      } catch {
        log.error({ elapsedMs, rawText }, `[diagnostic-api] respuesta no es JSON valido para '${action}'`);
        return {
          success: false,
          error: {
            type: "EXTERNAL_SERVICE_ERROR",
            message: `Respuesta de diagnostico no es un JSON valido: ${rawText.slice(0, 100)}`,
            retryable: true,
          },
        };
      }

      const cleanData = sanitizeForPostgresJson(
        Array.isArray(parsedData) ? parsedData[0] || {} : parsedData,
      ) as Record<string, unknown>;

      log.info({ elapsedMs, action }, `[diagnostic-api] diagnostico ejecutado exitosamente`);

      // Si la respuesta ya viene envuelta con { success, result, error }
      if (cleanData.success === true && typeof cleanData.result === "object" && cleanData.result !== null) {
        return {
          success: true,
          result: cleanData.result as Record<string, unknown>,
        };
      }

      if (cleanData.success === false && typeof cleanData.error === "object" && cleanData.error !== null) {
        const err = cleanData.error as Record<string, unknown>;
        return {
          success: false,
          error: {
            type: (typeof err.type === "string" ? err.type : "EXTERNAL_SERVICE_ERROR") as any,
            message: typeof err.message === "string" ? err.message : "Error retornado por diagnostico",
            retryable: typeof err.retryable === "boolean" ? err.retryable : false,
          },
        };
      }

      return {
        success: true,
        result: cleanData,
      };
    } catch (error) {
      const elapsedMs = Date.now() - start;
      if (error instanceof Error && error.name === "AbortError") {
        log.error({ elapsedMs, timeoutMs: this.timeoutMs }, `[diagnostic-api] timeout abortado para '${action}'`);
        return {
          success: false,
          error: {
            type: "TIMEOUT",
            message: `Timeout de ${this.timeoutMs}ms llamando al microservicio de diagnostico para '${action}'`,
            retryable: true,
          },
        };
      }

      const msg = error instanceof Error ? error.message : "Error desconocido llamando a diagnostico";
      log.error({ elapsedMs, err: msg }, `[diagnostic-api] error de red llamando a '${action}'`);
      return {
        success: false,
        error: {
          type: "EXTERNAL_SERVICE_ERROR",
          message: msg,
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
