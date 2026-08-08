import type { Pool } from "pg";
import type { Agent, AgentRole } from "../../domain/agent.entity";
import type { AgentRepositoryPort, CreateAgentInput } from "../../application/ports/agent.repository.port";

type AgentRow = {
  id: string;
  name: string;
  email: string;
  role: AgentRole;
  primary_department_id: string | null;
  active: boolean;
  created_at: Date;
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

  async create(input: CreateAgentInput): Promise<Agent> {
    const { rows } = await this.pool.query<AgentRow>(
      `INSERT INTO agent (name, email, role, primary_department_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [input.name, input.email, input.role ?? "agent", input.primaryDepartmentId ?? null],
    );
    return mapRow(rows[0]!);
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
}
