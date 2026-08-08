import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  Escalation,
  EscalationPriority,
  EscalationStatus,
  EscalationSummary,
} from "../../domain/escalation.entity";
import type {
  CreateEscalationInput,
  EscalationRepositoryPort,
  ListEscalationsFilter,
} from "../../application/ports/escalation.repository.port";

type EscalationRow = {
  id: string;
  case_id: string;
  department_id: string | null;
  priority: EscalationPriority;
  reason: string;
  summary: EscalationSummary;
  status: EscalationStatus;
  assigned_agent_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
};

function mapRow(row: EscalationRow): Escalation {
  return {
    id: row.id,
    caseId: row.case_id,
    departmentId: row.department_id,
    priority: row.priority,
    reason: row.reason,
    summary: row.summary,
    status: row.status,
    assignedAgentId: row.assigned_agent_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class EscalationRepositoryPg implements EscalationRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateEscalationInput): Promise<Escalation> {
    const { rows } = await this.pool.query<EscalationRow>(
      `INSERT INTO escalation (case_id, department_id, priority, reason, summary, status, assigned_agent_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', $6)
       RETURNING *`,
      [
        input.caseId,
        input.departmentId,
        input.priority ?? "normal",
        input.reason,
        JSON.stringify(input.summary),
        input.assignedAgentId ?? null,
      ],
    );
    return mapRow(rows[0]!);
  }

  async findById(id: string): Promise<Escalation | null> {
    const { rows } = await this.pool.query<EscalationRow>(`SELECT * FROM escalation WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByCaseId(caseId: string): Promise<Escalation | null> {
    const { rows } = await this.pool.query<EscalationRow>(
      `SELECT * FROM escalation WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [caseId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async list(filter: ListEscalationsFilter): Promise<Escalation[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.triage) {
      clauses.push(`department_id IS NULL`);
    } else if (filter.departmentId !== undefined) {
      params.push(filter.departmentId);
      clauses.push(`department_id = $${params.length}`);
    }

    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query<EscalationRow>(
      `SELECT * FROM escalation ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(mapRow);
  }

  async updateAssignment(
    id: string,
    input: {
      assignedAgentId: string | null;
      status: EscalationStatus;
      departmentId?: string | null;
    },
  ): Promise<Escalation> {
    const { rows } = await this.pool.query<EscalationRow>(
      `UPDATE escalation
       SET assigned_agent_id = $2,
           status = $3,
           department_id = COALESCE($4, department_id)
       WHERE id = $1
       RETURNING *`,
      [id, input.assignedAgentId, input.status, input.departmentId ?? null],
    );
    return mapRow(rows[0]!);
  }
}

/** Fake en memoria para tests. */
export class EscalationRepositoryFake implements EscalationRepositoryPort {
  readonly items = new Map<string, Escalation>();

  async create(input: CreateEscalationInput): Promise<Escalation> {
    const escalation: Escalation = {
      id: randomUUID(),
      caseId: input.caseId,
      departmentId: input.departmentId,
      priority: input.priority ?? "normal",
      reason: input.reason,
      summary: input.summary,
      status: "PENDING",
      assignedAgentId: input.assignedAgentId ?? null,
      createdAt: new Date(),
      resolvedAt: null,
    };
    this.items.set(escalation.id, escalation);
    return escalation;
  }

  async findById(id: string): Promise<Escalation | null> {
    return this.items.get(id) ?? null;
  }

  async findByCaseId(caseId: string): Promise<Escalation | null> {
    return [...this.items.values()].find((e) => e.caseId === caseId) ?? null;
  }

  async list(filter: ListEscalationsFilter): Promise<Escalation[]> {
    return [...this.items.values()].filter((e) => {
      if (filter.triage && e.departmentId !== null) return false;
      if (!filter.triage && filter.departmentId !== undefined && e.departmentId !== filter.departmentId) {
        return false;
      }
      if (filter.status && e.status !== filter.status) return false;
      return true;
    });
  }

  async updateAssignment(
    id: string,
    input: {
      assignedAgentId: string | null;
      status: EscalationStatus;
      departmentId?: string | null;
    },
  ): Promise<Escalation> {
    const existing = this.items.get(id);
    if (!existing) throw new Error(`Escalation fake ${id} no encontrada`);
    const updated: Escalation = {
      ...existing,
      assignedAgentId: input.assignedAgentId,
      status: input.status,
      departmentId: input.departmentId !== undefined ? input.departmentId : existing.departmentId,
    };
    this.items.set(id, updated);
    return updated;
  }
}
