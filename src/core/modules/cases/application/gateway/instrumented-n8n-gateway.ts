import { createHash } from "node:crypto";
import type { ExecuteActionParams, N8nActionResult, N8nGatewayPort } from "../ports/n8n-gateway.port";
import type { WorkflowExecutionRepositoryPort } from "../ports/workflow-execution.repository.port";

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
  ) {}

  async executeAction(params: ExecuteActionParams): Promise<N8nActionResult> {
    const idempotencyKey = `${params.caseId}:${params.action}:${canonicalHash(params.input)}`;

    const existing = await this.executionRepo.findByIdempotencyKey(idempotencyKey);
    if (existing && existing.status === "COMPLETED") {
      return { success: true, result: existing.output ?? {} };
    }
    if (existing && existing.status === "FAILED" && existing.error) {
      return { success: false, error: existing.error };
    }

    await this.executionRepo.start({
      workflowInstanceId: this.workflowInstanceId,
      caseId: params.caseId,
      action: params.action,
      input: params.input,
      idempotencyKey,
      correlationId: params.correlationId,
    });

    const result = await this.gateway.executeAction(params);

    if (result.success) {
      await this.executionRepo.complete({ idempotencyKey, output: result.result });
    } else {
      await this.executionRepo.fail({ idempotencyKey, error: result.error, output: null });
    }

    return result;
  }
}
