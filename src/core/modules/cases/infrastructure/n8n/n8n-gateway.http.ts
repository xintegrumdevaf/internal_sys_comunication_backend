import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "../../../../../shared/logging/logger";
import type { N8nWorkflowRegistryEntry } from "../../domain/n8n-workflow-registry-entry.entity";
import type { N8nWorkflowRegistryCache } from "../../application/services/n8n-workflow-registry-cache.service";
import type { ExecuteActionParams, N8nActionResult, N8nGatewayPort } from "../../application/ports/n8n-gateway.port";

const INITIAL_BACKOFF_MS = 200;

/**
 * Implementacion HTTP real de `N8nGatewayPort` (docs/spec/05_BUILD_PLAN.md
 * Etapa 3): resuelve la URL de cada accion desde `n8n_workflow_registry`
 * (via cache de corta duracion), hace el POST sincrono de
 * docs/spec/03_API_CONTRACT.md §B con `X-Internal-Api-Key`, y reintenta con
 * backoff exponencial solo si el error es `retryable`, reusando siempre el
 * mismo `idempotencyKey` (nunca uno nuevo por reintento).
 *
 * Solo se invoca a traves de `InstrumentedN8nGateway`, que es quien calcula
 * `idempotencyKey`/`executionId` antes de llegar aqui (docs/spec/03_API_CONTRACT.md §B).
 */
export class N8nGatewayHttp implements N8nGatewayPort {
  constructor(
    private readonly registryCache: N8nWorkflowRegistryCache,
    private readonly internalApiKey: string,
    private readonly logger: Logger,
  ) {}

  async executeAction(params: ExecuteActionParams): Promise<N8nActionResult> {
    if (!params.idempotencyKey || !params.executionId) {
      throw new Error(
        `N8nGatewayHttp.executeAction requiere idempotencyKey/executionId ya calculados ` +
          `(accion '${params.action}') — debe invocarse siempre a traves de InstrumentedN8nGateway`,
      );
    }

    const entry = await this.registryCache.resolve(params.action);
    if (!entry || !entry.active) {
      return {
        success: false,
        error: {
          type: "UNSUPPORTED",
          message: `La accion '${params.action}' no esta registrada o esta inactiva en n8n_workflow_registry`,
          retryable: false,
        },
      };
    }

    const log = this.logger.child({
      correlationId: params.correlationId,
      action: params.action,
      caseId: params.caseId,
    });
    const maxAttempts = entry.maxRetries + 1;
    let lastResult: N8nActionResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      log.info(
        { attempt, maxAttempts, url: entry.url, timeoutMs: entry.timeoutMs, input: params.input },
        `[n8n] enviando peticion a workflow '${params.action}'`,
      );
      lastResult = await this.callOnce(entry, params, log);
      if (lastResult.success || !lastResult.error.retryable || attempt === maxAttempts) {
        return lastResult;
      }

      const backoffMs = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      log.warn(
        {
          attempt,
          maxAttempts,
          backoffMs,
          errorType: lastResult.error.type,
          errorMessage: lastResult.error.message,
          idempotencyKey: params.idempotencyKey,
        },
        "[n8n] reintentando llamada tras error retryable",
      );
      await sleep(backoffMs);
    }

    return lastResult!;
  }

  private async callOnce(
    entry: N8nWorkflowRegistryEntry,
    params: ExecuteActionParams,
    log: Logger,
  ): Promise<N8nActionResult> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), entry.timeoutMs);
    const start = Date.now();

    try {
      const response = await fetch(entry.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Api-Key": this.internalApiKey,
        },
        body: JSON.stringify({
          correlationId: params.correlationId,
          executionId: params.executionId,
          idempotencyKey: params.idempotencyKey,
          caseId: params.caseId,
          conversationId: params.conversationId,
          input: params.input,
        }),
        signal: controller.signal,
      });

      const elapsedMs = Date.now() - start;

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        log.error(
          { status: response.status, elapsedMs, body: errorText },
          `[n8n] respuesta HTTP no exitosa para '${params.action}'`,
        );
        return {
          success: false,
          error: {
            type: "EXTERNAL_SERVICE_ERROR",
            message: `n8n respondio ${response.status} para la accion '${params.action}'`,
            retryable: response.status >= 500,
          },
        };
      }

      let data: unknown;
      const rawText = await response.text();
      try {
        data = JSON.parse(rawText);
      } catch {
        log.error(
          { elapsedMs, rawText },
          `[n8n] respuesta no es JSON valido para '${params.action}'`,
        );
        return {
          success: false,
          error: {
            type: "EXTERNAL_SERVICE_ERROR",
            message: `Respuesta de n8n no es un JSON valido: ${rawText.slice(0, 100)}`,
            retryable: true,
          },
        };
      }

      if (Array.isArray(data)) {
        data = data[0] || {};
      }

      const normalized = normalizeN8nPayload(data, params.action);
      log.info(
        { elapsedMs, success: normalized.success, action: params.action },
        `[n8n] respuesta procesada con exito para '${params.action}'`,
      );
      return normalized;
    } catch (error) {
      const elapsedMs = Date.now() - start;
      if (error instanceof Error && error.name === "AbortError") {
        log.error({ elapsedMs, timeoutMs: entry.timeoutMs }, `[n8n] timeout abortado para '${params.action}'`);
        return {
          success: false,
          error: {
            type: "TIMEOUT",
            message: `timeout de ${entry.timeoutMs}ms llamando a n8n para la accion '${params.action}'`,
            retryable: true,
          },
        };
      }
      const msg = error instanceof Error ? error.message : "error desconocido llamando a n8n";
      log.error({ elapsedMs, err: msg }, `[n8n] error de red llamando a '${params.action}'`);
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

import { sanitizeForPostgresJson } from "../../../../../shared/db/sanitize-json";

function normalizeN8nPayload(rawData: unknown, action: string): N8nActionResult {
  const data = sanitizeForPostgresJson(rawData);
  if (typeof data !== "object" || data === null) {
    return {
      success: false,
      error: {
        type: "EXTERNAL_SERVICE_ERROR",
        message: `Respuesta vacia o invalida de n8n para '${action}'`,
        retryable: true,
      },
    };
  }

  const obj = data as Record<string, unknown>;

  // Formato estandar contract: { success: true, result: { ... } }
  if (obj.success === true && typeof obj.result === "object" && obj.result !== null) {
    return {
      success: true,
      result: obj.result as Record<string, unknown>,
    };
  }

  // Formato estandar contract: { success: false, error: { type, message, retryable } }
  if (obj.success === false && typeof obj.error === "object" && obj.error !== null) {
    const err = obj.error as Record<string, unknown>;
    return {
      success: false,
      error: {
        type: (typeof err.type === "string" ? err.type : "EXTERNAL_SERVICE_ERROR") as any,
        message: typeof err.message === "string" ? err.message : "Error retornado por n8n",
        retryable: typeof err.retryable === "boolean" ? err.retryable : false,
      },
    };
  }

  // Si trae directamente el resultado sin envoltorio { success: true }
  if (obj.status !== undefined || obj.found !== undefined || obj.hasDebt !== undefined || obj.workflow !== undefined) {
    return {
      success: true,
      result: obj,
    };
  }

  // Si vino un mensaje tipo {"message": "Workflow was started"}
  return {
    success: false,
    error: {
      type: "EXTERNAL_SERVICE_ERROR",
      message: typeof obj.message === "string" ? obj.message : "Respuesta no estructurada de n8n",
      retryable: true,
    },
  };
}
