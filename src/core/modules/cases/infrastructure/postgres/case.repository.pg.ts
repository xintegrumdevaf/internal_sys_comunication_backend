import type { Pool } from "pg";
import { withTransaction } from "../../../../../shared/db/pool";
import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { Case, CaseStatus } from "../../domain/case.entity";
import { TERMINAL_CASE_STATUSES } from "../../domain/case.entity";
import type { CaseContext } from "../../domain/contexts/case-context";
import type { WorkflowInstance } from "../../domain/workflow-instance.entity";
import type { AutomationState } from "../../domain/automation-state.entity";
import type {
  ApplyCaseTransitionInput,
  CaseAggregate,
  CaseRepositoryPort,
  CreateCaseInput,
} from "../../application/ports/case.repository.port";

type CaseRow = {
  id: string;
  conversation_id: string;
  department_id: string | null;
  assigned_agent_id: string | null;
  workflow_type: string;
  status: CaseStatus;
  context: CaseContext;
  version: number;
  last_activity_at: Date;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type WorkflowInstanceRow = {
  id: string;
  case_id: string;
  workflow_type: string;
  current_state: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};

type AutomationStateRow = {
  case_id: string;
  enabled: boolean;
  disabled_reason: string | null;
  changed_at: Date;
  changed_by: string | null;
};

// Columnas de workflow_instance aliadadas con prefijo `wi_` en los JOIN de
// abajo — se evita `row_to_json` a proposito: ese helper serializa timestamps
// como texto ISO en vez de dejar que el driver de pg los parsee como `Date`.
type CaseWithInstanceRow = CaseRow & {
  wi_id: string;
  wi_workflow_type: string;
  wi_current_state: string;
  wi_version: number;
  wi_created_at: Date;
  wi_updated_at: Date;
};

const CASE_WITH_INSTANCE_SELECT = `
  c.*,
  wi.id AS wi_id,
  wi.workflow_type AS wi_workflow_type,
  wi.current_state AS wi_current_state,
  wi.version AS wi_version,
  wi.created_at AS wi_created_at,
  wi.updated_at AS wi_updated_at
`;

function mapCaseWithInstanceRow(row: CaseWithInstanceRow): CaseAggregate {
  return {
    case: mapCaseRow(row),
    workflowInstance: mapWorkflowInstanceRow({
      id: row.wi_id,
      case_id: row.id,
      workflow_type: row.wi_workflow_type,
      current_state: row.wi_current_state,
      version: row.wi_version,
      created_at: row.wi_created_at,
      updated_at: row.wi_updated_at,
    }),
  };
}

function mapCaseRow(row: CaseRow): Case {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    departmentId: row.department_id,
    assignedAgentId: row.assigned_agent_id,
    workflowType: row.workflow_type,
    status: row.status,
    context: row.context,
    version: row.version,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkflowInstanceRow(row: WorkflowInstanceRow): WorkflowInstance {
  return {
    id: row.id,
    caseId: row.case_id,
    workflowType: row.workflow_type,
    currentState: row.current_state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAutomationStateRow(row: AutomationStateRow): AutomationState {
  return {
    caseId: row.case_id,
    enabled: row.enabled,
    disabledReason: row.disabled_reason,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
  };
}

function conflictError(entity: string, id: string): DomainError {
  return new DomainError(
    "BUSINESS_ERROR",
    `Conflicto de concurrencia optimista actualizando ${entity} ${id}: la version esperada ya no coincide`,
    { retryable: true },
  );
}

export class CaseRepositoryPg implements CaseRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateCaseInput): Promise<CaseAggregate> {
    return withTransaction(this.pool, async (client) => {
      const { rows: caseRows } = await client.query<CaseRow>(
        `INSERT INTO "case" (conversation_id, department_id, workflow_type, status, context, expires_at)
         VALUES ($1, $2, $3, 'NEW', $4, $5)
         RETURNING *`,
        [input.conversationId, input.departmentId, input.workflowType, input.context, input.expiresAt],
      );
      const caseRow = caseRows[0]!;

      const { rows: instanceRows } = await client.query<WorkflowInstanceRow>(
        `INSERT INTO workflow_instance (case_id, workflow_type, current_state)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [caseRow.id, input.workflowType, input.initialState],
      );

      await client.query(`INSERT INTO automation_state (case_id) VALUES ($1)`, [caseRow.id]);

      return { case: mapCaseRow(caseRow), workflowInstance: mapWorkflowInstanceRow(instanceRows[0]!) };
    });
  }

  async findById(caseId: string): Promise<CaseAggregate | null> {
    const { rows } = await this.pool.query<CaseWithInstanceRow>(
      `SELECT ${CASE_WITH_INSTANCE_SELECT}
       FROM "case" c
       JOIN workflow_instance wi ON wi.case_id = c.id
       WHERE c.id = $1`,
      [caseId],
    );
    return rows[0] ? mapCaseWithInstanceRow(rows[0]) : null;
  }

  async findActiveByConversation(conversationId: string): Promise<CaseAggregate | null> {
    const { rows } = await this.pool.query<CaseWithInstanceRow>(
      `SELECT ${CASE_WITH_INSTANCE_SELECT}
       FROM "case" c
       JOIN workflow_instance wi ON wi.case_id = c.id
       WHERE c.conversation_id = $1 AND c.status IN ('ACTIVE', 'WAITING_USER')
       ORDER BY c.updated_at DESC
       LIMIT 1`,
      [conversationId],
    );
    return rows[0] ? mapCaseWithInstanceRow(rows[0]) : null;
  }

  async findPausedByConversationAndType(
    conversationId: string,
    workflowType: string,
  ): Promise<CaseAggregate | null> {
    const { rows } = await this.pool.query<CaseWithInstanceRow>(
      `SELECT ${CASE_WITH_INSTANCE_SELECT}
       FROM "case" c
       JOIN workflow_instance wi ON wi.case_id = c.id
       WHERE c.conversation_id = $1 AND c.workflow_type = $2 AND c.status = 'PAUSED'
       ORDER BY c.updated_at DESC
       LIMIT 1`,
      [conversationId, workflowType],
    );
    return rows[0] ? mapCaseWithInstanceRow(rows[0]) : null;
  }

  async listByConversation(conversationId: string): Promise<Case[]> {
    const { rows } = await this.pool.query<CaseRow>(
      `SELECT * FROM "case" WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    );
    return rows.map(mapCaseRow);
  }

  async listAutomatableExpiring(now: Date): Promise<Case[]> {
    const { rows } = await this.pool.query<CaseRow>(
      `SELECT * FROM "case"
       WHERE status NOT IN (${TERMINAL_CASE_STATUSES.map((_, i) => `$${i + 2}`).join(", ")})
         AND expires_at IS NOT NULL
         AND expires_at <= $1
       ORDER BY expires_at ASC`,
      [now, ...TERMINAL_CASE_STATUSES],
    );
    return rows.map(mapCaseRow);
  }

  async applyTransition(input: ApplyCaseTransitionInput): Promise<CaseAggregate> {
    return withTransaction(this.pool, async (client) => {
      const { rows: caseRows } = await client.query<CaseRow>(
        `UPDATE "case"
         SET status = $1,
             context = $2,
             expires_at = $3,
             department_id = COALESCE($4, department_id),
             version = version + 1,
             last_activity_at = now(),
             updated_at = now()
         WHERE id = $5 AND version = $6
         RETURNING *`,
        [
          input.status,
          input.context,
          input.expiresAt,
          input.departmentId ?? null,
          input.caseId,
          input.expectedCaseVersion,
        ],
      );
      if (caseRows.length === 0) {
        throw conflictError("case", input.caseId);
      }

      const { rows: instanceRows } = await client.query<WorkflowInstanceRow>(
        `UPDATE workflow_instance
         SET current_state = $1,
             version = version + 1,
             updated_at = now()
         WHERE case_id = $2 AND version = $3
         RETURNING *`,
        [input.currentState, input.caseId, input.expectedWorkflowVersion],
      );
      if (instanceRows.length === 0) {
        throw conflictError("workflow_instance", input.caseId);
      }

      return { case: mapCaseRow(caseRows[0]!), workflowInstance: mapWorkflowInstanceRow(instanceRows[0]!) };
    });
  }

  async setAssignedAgent(caseId: string, agentId: string | null): Promise<void> {
    await this.pool.query(`UPDATE "case" SET assigned_agent_id = $2, updated_at = now() WHERE id = $1`, [
      caseId,
      agentId,
    ]);
  }

  async getAutomationState(caseId: string): Promise<AutomationState | null> {
    const { rows } = await this.pool.query<AutomationStateRow>(
      `SELECT * FROM automation_state WHERE case_id = $1`,
      [caseId],
    );
    return rows[0] ? mapAutomationStateRow(rows[0]) : null;
  }

  async setAutomationEnabled(
    caseId: string,
    enabled: boolean,
    options: { reason?: string | null; changedBy?: string | null },
  ): Promise<AutomationState> {
    const { rows } = await this.pool.query<AutomationStateRow>(
      `UPDATE automation_state
       SET enabled = $2, disabled_reason = $3, changed_at = now(), changed_by = $4
       WHERE case_id = $1
       RETURNING *`,
      [caseId, enabled, options.reason ?? null, options.changedBy ?? null],
    );
    return mapAutomationStateRow(rows[0]!);
  }

  async appendEvent(caseId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query(`INSERT INTO workflow_event (case_id, type, payload) VALUES ($1, $2, $3)`, [
      caseId,
      type,
      payload,
    ]);
  }

  async listEvents(
    caseId: string,
  ): Promise<Array<{ type: string; payload: Record<string, unknown>; occurredAt: Date }>> {
    const { rows } = await this.pool.query<{
      type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT type, payload, occurred_at FROM workflow_event WHERE case_id = $1 ORDER BY occurred_at ASC`,
      [caseId],
    );
    return rows.map((row) => ({
      type: row.type,
      payload: row.payload ?? {},
      occurredAt: row.occurred_at,
    }));
  }

  async countActiveCasesByAgent(agentIds: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const id of agentIds) result[id] = 0;
    if (agentIds.length === 0) return result;

    const { rows } = await this.pool.query<{ assigned_agent_id: string; count: string }>(
      `SELECT assigned_agent_id, COUNT(*)::text AS count
       FROM "case"
       WHERE status = 'HUMAN_ACTIVE' AND assigned_agent_id = ANY($1::uuid[])
       GROUP BY assigned_agent_id`,
      [agentIds],
    );
    for (const row of rows) {
      result[row.assigned_agent_id] = Number(row.count);
    }
    return result;
  }
}
