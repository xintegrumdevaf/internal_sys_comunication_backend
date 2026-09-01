import { createHash } from "node:crypto";
import type { ExecuteActionParams, N8nActionResult, N8nGatewayPort } from "../ports/n8n-gateway.port";
import type { WorkflowExecutionRepositoryPort } from "../ports/workflow-execution.repository.port";
import type { Logger } from "../../../../../shared/logging/logger";

function canonicalHash(input: Record<string, unknown>): string {
  const sortedKeys = Object.keys(input).sort();
  const canonical = JSON.stringify(input, sortedKeys);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Decorator (docs/skills/design-patterns-backend.md) sobre `N8nGatewayPort`:
 * registra cada llamada como `workflow_execution` (docs/spec/01_DATA_MODEL.md §2)
 * y respeta idempotencia (docs/spec/03_API_CONTRACT.md §B) — un reintento con
 * la misma `idempotencyKey` devuelve el resultado ya registrado sin volver a
 * llamar al gateway real.
 */
export class InstrumentedN8nGateway implements N8nGatewayPort {
  constructor(
    private readonly gateway: N8nGatewayPort,
    private readonly executionRepo: WorkflowExecutionRepositoryPort,
    private readonly workflowInstanceId: string,
    private readonly logger: Logger,
  ) {}

  async executeAction(params: ExecuteActionParams): Promise<N8nActionResult> {
    const idempotencyKey = `${params.caseId}:${params.action}:${canonicalHash(params.input)}`;
    const log = this.logger.child({ correlationId: params.correlationId, caseId: params.caseId, action: params.action });

    const existing = await this.executionRepo.findByIdempotencyKey(idempotencyKey);
    if (existing && existing.status === "COMPLETED") {
      log.info({ idempotencyKey }, "accion de n8n ya ejecutada, reutilizando resultado (idempotencia)");
      return { success: true, result: existing.output ?? {} };
    }

    const execution = await this.executionRepo.start({
      workflowInstanceId: this.workflowInstanceId,
      caseId: params.caseId,
      action: params.action,
      input: params.input,
      idempotencyKey,
      correlationId: params.correlationId,
    });
    log.info({ idempotencyKey, executionId: execution.id }, "ejecutando accion de n8n");

    const startedAt = Date.now();
    const result = await this.gateway.executeAction({ ...params, idempotencyKey, executionId: execution.id });
    const durationMs = Date.now() - startedAt;

    if (result.success) {
      await this.executionRepo.complete({ idempotencyKey, output: result.result });
      log.info({ idempotencyKey, durationMs }, "accion de n8n completada");
    } else {
      await this.executionRepo.fail({ idempotencyKey, error: result.error, output: null });
      log.warn({ idempotencyKey, durationMs, error: result.error }, "accion de n8n fallo");
    }

    return result;
  }
}
