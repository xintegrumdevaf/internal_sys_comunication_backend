import type { DomainErrorType } from "../../../../shared/errors/domain-errors";

export type WorkflowExecutionStatus = "DISPATCHED" | "COMPLETED" | "FAILED";

export type WorkflowExecutionError = {
  type: DomainErrorType;
  message: string;
  retryable: boolean;
};

export interface WorkflowExecution {
  id: string;
  workflowInstanceId: string;
  caseId: string;
  action: string;
  status: WorkflowExecutionStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: WorkflowExecutionError | null;
  idempotencyKey: string;
  correlationId: string;
  startedAt: Date;
  completedAt: Date | null;
}
