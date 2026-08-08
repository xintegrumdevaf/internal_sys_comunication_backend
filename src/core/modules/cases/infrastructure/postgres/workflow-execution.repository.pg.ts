import type { Pool } from "pg";
import type { WorkflowExecution, WorkflowExecutionError, WorkflowExecutionStatus } from "../../domain/workflow-execution.entity";
import type {
  FinishExecutionInput,
  StartExecutionInput,
  WorkflowExecutionRepositoryPort,
} from "../../application/ports/workflow-execution.repository.port";

type WorkflowExecutionRow = {
  id: string;
  workflow_instance_id: string;
  case_id: string;
  action: string;
  status: WorkflowExecutionStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: WorkflowExecutionError | null;
  idempotency_key: string;
  correlation_id: string;
  started_at: Date;
  completed_at: Date | null;
};

function mapRow(row: WorkflowExecutionRow): WorkflowExecution {
  return {
    id: row.id,
    workflowInstanceId: row.workflow_instance_id,
    caseId: row.case_id,
    action: row.action,
    status: row.status,
    input: row.input,
    output: row.output,
    error: row.error,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * docs/spec/01_DATA_MODEL.md §2/§3 — `UNIQUE(idempotency_key)`: un reintento
 * con la misma key nunca inserta una segunda fila (`ON CONFLICT DO NOTHING`
 * + lectura de la existente), consistente con la idempotencia obligatoria de
 * AGENTS.md.
 */
export class WorkflowExecutionRepositoryPg implements WorkflowExecutionRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async start(input: StartExecutionInput): Promise<WorkflowExecution> {
    const { rows } = await this.pool.query<WorkflowExecutionRow>(
      `INSERT INTO workflow_execution
         (workflow_instance_id, case_id, action, status, input, idempotency_key, correlation_id)
       VALUES ($1, $2, $3, 'DISPATCHED', $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.workflowInstanceId,
        input.caseId,
        input.action,
        input.input,
        input.idempotencyKey,
        input.correlationId,
      ],
    );
    if (rows[0]) {
      return mapRow(rows[0]);
    }
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (!existing) {
      throw new Error(`No se pudo crear ni recuperar workflow_execution para ${input.idempotencyKey}`);
    }
    return existing;
  }

  async complete(input: FinishExecutionInput): Promise<WorkflowExecution> {
    const { rows } = await this.pool.query<WorkflowExecutionRow>(
      `UPDATE workflow_execution
       SET status = 'COMPLETED', output = $2, error = NULL, completed_at = now()
       WHERE idempotency_key = $1
       RETURNING *`,
      [input.idempotencyKey, input.output ?? {}],
    );
    return mapRow(rows[0]!);
  }

  async fail(input: FinishExecutionInput): Promise<WorkflowExecution> {
    const { rows } = await this.pool.query<WorkflowExecutionRow>(
      `UPDATE workflow_execution
       SET status = 'FAILED', error = $2, output = NULL, completed_at = now()
       WHERE idempotency_key = $1
       RETURNING *`,
      [input.idempotencyKey, input.error ?? null],
    );
    return mapRow(rows[0]!);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WorkflowExecution | null> {
    const { rows } = await this.pool.query<WorkflowExecutionRow>(
      `SELECT * FROM workflow_execution WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listByCase(caseId: string): Promise<WorkflowExecution[]> {
    const { rows } = await this.pool.query<WorkflowExecutionRow>(
      `SELECT * FROM workflow_execution WHERE case_id = $1 ORDER BY started_at ASC`,
      [caseId],
    );
    return rows.map(mapRow);
  }
}
