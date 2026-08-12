import type { Pool } from "pg";
import type { Agent, AgentRole } from "../../domain/agent.entity";
import type {
  AgentRepositoryPort,
  CreateAgentInput,
  UpdateAgentPatch,
} from "../../application/ports/agent.repository.port";

type AgentRow = {
  id: string;
  name: string;
  email: string;
  role: AgentRole;
  primary_department_id: string | null;
  active: boolean;
  created_at: Date;
  password_hash: string | null;
};

function mapRow(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    primaryDepartmentId: row.primary_department_id,
    active: row.active,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
  };
}

export class AgentRepositoryPg implements AgentRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Agent[]> {
    const { rows } = await this.pool.query<AgentRow>(`SELECT * FROM agent ORDER BY name ASC`);
    return rows.map(mapRow);
  }

  async findById(id: string): Promise<Agent | null> {
    const { rows } = await this.pool.query<AgentRow>(`SELECT * FROM agent WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByEmail(email: string): Promise<Agent | null> {
    const { rows } = await this.pool.query<AgentRow>(`SELECT * FROM agent WHERE lower(email) = lower($1)`, [
      email,
    ]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(input: CreateAgentInput): Promise<Agent> {
    const { rows } = await this.pool.query<AgentRow>(
      `INSERT INTO agent (name, email, role, primary_department_id, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [
        input.name,
        input.email,
        input.role ?? "agent",
        input.primaryDepartmentId ?? null,
        input.passwordHash ?? null,
      ],
    );
    return mapRow(rows[0]!);
  }

  async update(id: string, patch: UpdateAgentPatch): Promise<Agent> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (patch.name !== undefined) {
      sets.push(`name = $${i++}`);
      values.push(patch.name);
    }
    if (patch.email !== undefined) {
      sets.push(`email = $${i++}`);
      values.push(patch.email);
    }
    if (patch.role !== undefined) {
      sets.push(`role = $${i++}`);
      values.push(patch.role);
    }
    if (patch.primaryDepartmentId !== undefined) {
      sets.push(`primary_department_id = $${i++}`);
      values.push(patch.primaryDepartmentId);
    }
    if (patch.active !== undefined) {
      sets.push(`active = $${i++}`);
      values.push(patch.active);
    }
    if (patch.passwordHash !== undefined) {
      sets.push(`password_hash = $${i++}`);
      values.push(patch.passwordHash);
    }

    if (sets.length === 0) {
      const current = await this.findById(id);
      if (!current) throw new Error(`agent ${id} not found`);
      return current;
    }

    values.push(id);
    const { rows } = await this.pool.query<AgentRow>(
      `UPDATE agent SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    return mapRow(rows[0]!);
  }

  async countActiveAdmins(excludeAgentId?: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent
       WHERE role = 'admin' AND active = true AND ($1::uuid IS NULL OR id != $1)`,
      [excludeAgentId ?? null],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async addMembership(agentId: string, departmentId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_membership (agent_id, department_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [agentId, departmentId],
    );
  }

  async belongsToDepartment(agentId: string, departmentId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM agent_membership WHERE agent_id = $1 AND department_id = $2`,
      [agentId, departmentId],
    );
    return rows.length > 0;
  }

  async listMembershipDepartmentIds(agentId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ department_id: string }>(
      `SELECT department_id FROM agent_membership WHERE agent_id = $1`,
      [agentId],
    );
    return rows.map((r) => r.department_id);
  }
}
