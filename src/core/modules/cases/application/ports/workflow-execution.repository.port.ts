import type { WorkflowExecution, WorkflowExecutionError } from "../../domain/workflow-execution.entity";

export type StartExecutionInput = {
  workflowInstanceId: string;
  caseId: string;
  action: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
  correlationId: string;
};

export type FinishExecutionInput = {
  idempotencyKey: string;
  output?: Record<string, unknown> | null;
  error?: WorkflowExecutionError | null;
};

export interface WorkflowExecutionRepositoryPort {
  /** Idempotente por UNIQUE(idempotency_key) — devuelve la existente si ya se habia dispatchado. */
  start(input: StartExecutionInput): Promise<WorkflowExecution>;
  complete(input: FinishExecutionInput): Promise<WorkflowExecution>;
  fail(input: FinishExecutionInput): Promise<WorkflowExecution>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WorkflowExecution | null>;
  listByCase(caseId: string): Promise<WorkflowExecution[]>;
}
