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
  auto_assign_enabled: boolean;
  must_change_password: boolean;
  created_at: Date;
  password_hash: string | null;
  department_ids?: string[];
};

function mapRow(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    primaryDepartmentId: row.primary_department_id,
    departmentIds: row.department_ids ?? [],
    active: row.active,
    autoAssignEnabled: row.auto_assign_enabled,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
  };
}

const AGENT_SELECT_SQL = `
  SELECT 
    a.*,
    COALESCE(array_agg(am.department_id) FILTER (WHERE am.department_id IS NOT NULL), '{}') AS department_ids
  FROM agent a
  LEFT JOIN agent_membership am ON a.id = am.agent_id
`;

export class AgentRepositoryPg implements AgentRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Agent[]> {
    const { rows } = await this.pool.query<AgentRow>(
      `${AGENT_SELECT_SQL} GROUP BY a.id ORDER BY a.name ASC`,
    );
    return rows.map(mapRow);
  }

  async findById(id: string): Promise<Agent | null> {
    const { rows } = await this.pool.query<AgentRow>(
      `${AGENT_SELECT_SQL} WHERE a.id = $1 GROUP BY a.id`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByEmail(email: string): Promise<Agent | null> {
    const { rows } = await this.pool.query<AgentRow>(
      `${AGENT_SELECT_SQL} WHERE lower(a.email) = lower($1) GROUP BY a.id`,
      [email],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(input: CreateAgentInput): Promise<Agent> {
    const { rows } = await this.pool.query<AgentRow>(
      `INSERT INTO agent (name, email, role, primary_department_id, auto_assign_enabled, must_change_password, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [
        input.name,
        input.email,
        input.role ?? "agent",
        input.primaryDepartmentId ?? null,
        input.autoAssignEnabled ?? false,
        input.mustChangePassword ?? true,
        input.passwordHash ?? null,
      ],
    );
    const created = rows[0]!;
    if (input.departmentIds && input.departmentIds.length > 0) {
      await this.setMemberships(created.id, input.departmentIds);
      return {
        ...mapRow(created),
        departmentIds: input.departmentIds,
      };
    }
    return mapRow(created);
  }

  async update(id: string, patch: UpdateAgentPatch): Promise<Agent> {
    if (patch.departmentIds !== undefined) {
      await this.setMemberships(id, patch.departmentIds);
    }

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
    if (patch.autoAssignEnabled !== undefined) {
      sets.push(`auto_assign_enabled = $${i++}`);
      values.push(patch.autoAssignEnabled);
    }
    if (patch.mustChangePassword !== undefined) {
      sets.push(`must_change_password = $${i++}`);
      values.push(patch.mustChangePassword);
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
    await this.pool.query(
      `UPDATE agent SET ${sets.join(", ")} WHERE id = $${i}`,
      values,
    );

    const updated = await this.findById(id);
    if (!updated) throw new Error(`agent ${id} not found`);
    return updated;
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

  async setMemberships(agentId: string, departmentIds: string[]): Promise<void> {
    await this.pool.query(`DELETE FROM agent_membership WHERE agent_id = $1`, [agentId]);
    if (departmentIds.length > 0) {
      const uniqueDeptIds = [...new Set(departmentIds)];
      const values: string[] = [];
      const params: unknown[] = [agentId];
      let idx = 2;
      for (const deptId of uniqueDeptIds) {
        values.push(`($1, $${idx++})`);
        params.push(deptId);
      }
      await this.pool.query(
        `INSERT INTO agent_membership (agent_id, department_id) VALUES ${values.join(", ")} ON CONFLICT DO NOTHING`,
        params,
      );
    }
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
