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
  DashboardMetricsInput,
  DashboardMetricsResult,
} from "../../application/ports/case.repository.port";

import { sanitizeForPostgresJson } from "../../../../../shared/db/sanitize-json";

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

function mapAutomationStateRow(row?: AutomationStateRow | null): AutomationState {
  if (!row) {
    return {
      caseId: "",
      enabled: true,
      disabledReason: null,
      changedAt: new Date(),
      changedBy: null,
    };
  }
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
      `SELECT * FROM "case" WHERE conversation_id = $1 ORDER BY created_at DESC`,
      [conversationId],
    );
    return rows.map(mapCaseRow);
  }

  async listAutomatableExpiring(now: Date): Promise<Case[]> {
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const { rows } = await this.pool.query<CaseRow>(
      `SELECT * FROM "case"
       WHERE status NOT IN (${TERMINAL_CASE_STATUSES.map((_, i) => `$${i + 3}`).join(", ")})
         AND (
           (expires_at IS NOT NULL AND expires_at <= $1)
           OR (expires_at IS NULL AND last_activity_at <= $2)
         )
       ORDER BY expires_at ASC NULLS LAST, last_activity_at ASC`,
      [now, cutoff24h, ...TERMINAL_CASE_STATUSES],
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
          sanitizeForPostgresJson(input.context),
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
      `INSERT INTO automation_state (case_id, enabled, disabled_reason, changed_at, changed_by)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (case_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           disabled_reason = EXCLUDED.disabled_reason,
           changed_at = EXCLUDED.changed_at,
           changed_by = EXCLUDED.changed_by
       RETURNING *`,
      [caseId, enabled, options.reason ?? null, options.changedBy ?? null],
    );
    return mapAutomationStateRow(rows[0] ?? {
      case_id: caseId,
      enabled,
      disabled_reason: options.reason ?? null,
      changed_at: new Date(),
      changed_by: options.changedBy ?? null,
    });
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

  async getDashboardMetrics(input: DashboardMetricsInput): Promise<DashboardMetricsResult> {
    if (input.role === "agent") {
      const query = `
        WITH agent_cases AS (
          SELECT c.id, c.status, conv.unread_count,
                 EXISTS (SELECT 1 FROM message m WHERE m.case_id = c.id AND m.author = 'agent') AS has_agent_reply
          FROM "case" c
          JOIN conversation conv ON conv.id = c.conversation_id
          WHERE c.assigned_agent_id = $1::uuid
            AND c.status IN ('ESCALATED', 'HUMAN_ACTIVE', 'WAITING_USER')
        ),
        open_convs AS (
          SELECT COUNT(*)::int AS count
          FROM conversation conv
          WHERE conv.status = 'open'
            AND EXISTS (
              SELECT 1 FROM "case" c WHERE c.id = conv.active_case_id AND c.assigned_agent_id = $1::uuid
            )
        ),
        dept_escalations AS (
          SELECT COUNT(*)::int AS count
          FROM escalation e
          WHERE e.status = 'PENDING'
            AND ($2::uuid IS NULL OR e.department_id = $2::uuid)
        )
        SELECT
          COALESCE((SELECT count FROM open_convs), 0)::int AS open_conversations,
          COALESCE(COUNT(*) FILTER (WHERE status IN ('ESCALATED', 'HUMAN_ACTIVE')), 0)::int AS my_assigned_cases,
          COALESCE((SELECT count FROM dept_escalations), 0)::int AS escalated_pending,
          COALESCE(COUNT(*) FILTER (WHERE status = 'WAITING_USER'), 0)::int AS waiting_user,
          COALESCE(COUNT(*) FILTER (WHERE status IN ('ESCALATED', 'HUMAN_ACTIVE') AND (unread_count > 0 OR NOT has_agent_reply)), 0)::int AS unattended_cases
        FROM agent_cases;
      `;
      const { rows } = await this.pool.query(query, [input.targetUserId, input.primaryDepartmentId]);
      const r = rows[0] ?? {};
      return {
        openConversations: Number(r.open_conversations ?? 0),
        myAssignedCases: Number(r.my_assigned_cases ?? 0),
        escalatedPending: Number(r.escalated_pending ?? 0),
        waitingUser: Number(r.waiting_user ?? 0),
        unattendedCases: Number(r.unattended_cases ?? 0),
      };
    }

    if (input.role === "manager") {
      const deptIds = input.departmentIds && input.departmentIds.length > 0 ? input.departmentIds : null;
      const query = `
        WITH dept_scope AS (
          SELECT unnest($2::uuid[]) AS dept_id
        ),
        dept_cases AS (
          SELECT c.id, c.assigned_agent_id, c.status, c.department_id, conv.unread_count,
                 EXISTS (SELECT 1 FROM message m WHERE m.case_id = c.id AND m.author = 'agent') AS has_agent_reply
          FROM "case" c
          JOIN conversation conv ON conv.id = c.conversation_id
          WHERE (
            ($2::uuid[] IS NOT NULL AND c.department_id IN (SELECT dept_id FROM dept_scope))
            OR c.department_id IS NULL
          )
          AND c.status IN ('ESCALATED', 'HUMAN_ACTIVE', 'WAITING_USER', 'ACTIVE')
        ),
        dept_open_convs AS (
          SELECT COUNT(*)::int AS count
          FROM conversation conv
          JOIN "case" c ON c.id = conv.active_case_id
          WHERE conv.status = 'open'
            AND (
              ($2::uuid[] IS NOT NULL AND c.department_id IN (SELECT dept_id FROM dept_scope))
              OR c.department_id IS NULL
            )
        ),
        dept_escalations AS (
          SELECT COUNT(*)::int AS count
          FROM escalation e
          WHERE e.status = 'PENDING'
            AND (
              ($2::uuid[] IS NOT NULL AND e.department_id IN (SELECT dept_id FROM dept_scope))
              OR e.department_id IS NULL
            )
        ),
        agent_loads AS (
          SELECT a.id AS agent_id, a.name AS agent_name,
                 COUNT(c.id)::int AS active_cases
          FROM agent a
          LEFT JOIN "case" c ON c.assigned_agent_id = a.id AND c.status IN ('ESCALATED', 'HUMAN_ACTIVE')
          WHERE a.active = true
            AND (
              $2::uuid[] IS NULL
              OR a.primary_department_id IN (SELECT dept_id FROM dept_scope)
              OR EXISTS (
                SELECT 1 FROM agent_membership am
                WHERE am.agent_id = a.id AND am.department_id IN (SELECT dept_id FROM dept_scope)
              )
            )
          GROUP BY a.id, a.name
          ORDER BY active_cases DESC, a.name ASC
        )
        SELECT
          COALESCE((SELECT count FROM dept_open_convs), 0)::int AS open_conversations,
          COALESCE((SELECT COUNT(*)::int FROM dept_cases WHERE assigned_agent_id = $1::uuid AND status IN ('ESCALATED', 'HUMAN_ACTIVE')), 0)::int AS my_assigned_cases,
          COALESCE((SELECT count FROM dept_escalations), 0)::int AS escalated_pending,
          COALESCE((SELECT count FROM dept_escalations), 0)::int AS unassigned_queue,
          COALESCE(COUNT(*) FILTER (WHERE status = 'WAITING_USER'), 0)::int AS waiting_user,
          COALESCE(COUNT(*) FILTER (WHERE status IN ('ESCALATED', 'HUMAN_ACTIVE', 'ACTIVE')), 0)::int AS department_cases,
          COALESCE(COUNT(*) FILTER (WHERE status IN ('ESCALATED', 'HUMAN_ACTIVE') AND (unread_count > 0 OR NOT has_agent_reply)), 0)::int AS unattended_cases,
          COALESCE((SELECT json_agg(json_build_object('agentId', agent_id, 'agentName', agent_name, 'activeCases', active_cases)) FROM agent_loads), '[]'::json) AS team_load
        FROM dept_cases;
      `;
      const { rows } = await this.pool.query(query, [input.targetUserId, deptIds]);
      const r = rows[0] ?? {};
      return {
        openConversations: Number(r.open_conversations ?? 0),
        myAssignedCases: Number(r.my_assigned_cases ?? 0),
        escalatedPending: Number(r.escalated_pending ?? 0),
        unassignedQueue: Number(r.unassigned_queue ?? 0),
        waitingUser: Number(r.waiting_user ?? 0),
        departmentCases: Number(r.department_cases ?? 0),
        unattendedCases: Number(r.unattended_cases ?? 0),
        teamLoad: (r.team_load as Array<{ agentId: string; agentName: string; activeCases: number }>) ?? [],
      };
    }

    // Role === "admin"
    const query = `
      WITH all_active_cases AS (
        SELECT c.id, c.assigned_agent_id, c.status, c.department_id, conv.unread_count,
               EXISTS (SELECT 1 FROM message m WHERE m.case_id = c.id AND m.author = 'agent') AS has_agent_reply
        FROM "case" c
        JOIN conversation conv ON conv.id = c.conversation_id
        WHERE c.status IN ('ESCALATED', 'HUMAN_ACTIVE', 'WAITING_USER', 'ACTIVE')
      ),
      all_open_convs AS (
        SELECT COUNT(*)::int AS count
        FROM conversation conv
        WHERE conv.status = 'open'
      ),
      all_escalations AS (
        SELECT COUNT(*)::int AS count
        FROM escalation e
        WHERE e.status = 'PENDING'
      ),
      dept_breakdown AS (
        SELECT d.id AS department_id, d.name AS department_name,
               COUNT(c.id)::int AS active_cases
        FROM department d
        LEFT JOIN "case" c ON c.department_id = d.id AND c.status IN ('ESCALATED', 'HUMAN_ACTIVE', 'ACTIVE', 'WAITING_USER')
        WHERE d.active = true
        GROUP BY d.id, d.name
        ORDER BY active_cases DESC, d.name ASC
      )
      SELECT
        COALESCE((SELECT count FROM all_open_convs), 0)::int AS open_conversations,
        COALESCE((SELECT COUNT(*)::int FROM all_active_cases WHERE assigned_agent_id = $1::uuid AND status IN ('ESCALATED', 'HUMAN_ACTIVE')), 0)::int AS my_assigned_cases,
        COALESCE((SELECT count FROM all_escalations), 0)::int AS escalated_pending,
        COALESCE((SELECT count FROM all_escalations), 0)::int AS unassigned_queue,
        COALESCE(COUNT(*) FILTER (WHERE status = 'WAITING_USER'), 0)::int AS waiting_user,
        COALESCE(COUNT(*), 0)::int AS department_cases,
        COALESCE(COUNT(*) FILTER (WHERE status IN ('ESCALATED', 'HUMAN_ACTIVE') AND (unread_count > 0 OR NOT has_agent_reply)), 0)::int AS unattended_cases,
        COALESCE((SELECT json_agg(json_build_object(
          'id', department_id,
          'departmentId', department_id,
          'department_id', department_id,
          'name', department_name,
          'departmentName', department_name,
          'department_name', department_name,
          'activeCases', active_cases,
          'active_cases', active_cases,
          'count', active_cases,
          'casesCount', active_cases
        )) FROM dept_breakdown), '[]'::json) AS department_breakdown
      FROM all_active_cases;
    `;
    const { rows } = await this.pool.query(query, [input.targetUserId]);
    const r = rows[0] ?? {};
    return {
      openConversations: Number(r.open_conversations ?? 0),
      myAssignedCases: Number(r.my_assigned_cases ?? 0),
      escalatedPending: Number(r.escalated_pending ?? 0),
      unassignedQueue: Number(r.unassigned_queue ?? 0),
      waitingUser: Number(r.waiting_user ?? 0),
      departmentCases: Number(r.department_cases ?? 0),
      unattendedCases: Number(r.unattended_cases ?? 0),
      departmentBreakdown: (r.department_breakdown as Array<{ departmentId: string | null; departmentName: string; activeCases: number }>) ?? [],
    };
  }
}
