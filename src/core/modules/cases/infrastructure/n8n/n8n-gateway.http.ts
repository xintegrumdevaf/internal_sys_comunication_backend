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
      lastResult = await this.callOnce(entry, params);
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
          idempotencyKey: params.idempotencyKey,
        },
        "reintentando llamada a n8n tras error retryable",
      );
      await sleep(backoffMs);
    }

    return lastResult!;
  }

  private async callOnce(entry: N8nWorkflowRegistryEntry, params: ExecuteActionParams): Promise<N8nActionResult> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), entry.timeoutMs);

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

      if (!response.ok) {
        return {
          success: false,
          error: {
            type: "EXTERNAL_SERVICE_ERROR",
            message: `n8n respondio ${response.status} para la accion '${params.action}'`,
            // 5xx se trata como transitorio (retryable); 4xx es un error de
            // contrato (input invalido, URL mal configurada) que reintentar
            // no arregla.
            retryable: response.status >= 500,
          },
        };
      }

      return (await response.json()) as N8nActionResult;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          success: false,
          error: {
            type: "TIMEOUT",
            message: `timeout de ${entry.timeoutMs}ms llamando a n8n para la accion '${params.action}'`,
            retryable: true,
          },
        };
      }
      return {
        success: false,
        error: {
          type: "EXTERNAL_SERVICE_ERROR",
          message: error instanceof Error ? error.message : "error desconocido llamando a n8n",
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
