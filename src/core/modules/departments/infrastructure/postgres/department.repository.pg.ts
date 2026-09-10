import type { Pool } from "pg";
import type { Department, DepartmentVisibility } from "../../domain/department.entity";
import type {
  DepartmentCaseRouting,
  DepartmentHandlingMode,
} from "../../domain/department-case-routing.entity";
import type {
  CreateDepartmentInput,
  UpdateDepartmentInput,
  CreateDepartmentCaseRoutingInput,
  UpdateDepartmentCaseRoutingInput,
  DepartmentRepositoryPort,
} from "../../application/ports/department.repository.port";

type DepartmentRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: DepartmentVisibility;
  active: boolean;
  created_at: Date;
};

type RoutingRow = {
  id: string;
  department_id: string;
  intent_key: string;
  label: string;
  description: string;
  handling_mode: DepartmentHandlingMode;
  workflow_type: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: DepartmentRow): Department {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    visibility: row.visibility,
    active: row.active,
    createdAt: row.created_at,
  };
}

function mapRoutingRow(row: RoutingRow): DepartmentCaseRouting {
  return {
    id: row.id,
    departmentId: row.department_id,
    intentKey: row.intent_key,
    label: row.label,
    description: row.description,
    handlingMode: row.handling_mode,
    workflowType: row.workflow_type,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DepartmentRepositoryPg implements DepartmentRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Department[]> {
    const { rows } = await this.pool.query<DepartmentRow>(
      `SELECT * FROM department ORDER BY name ASC`,
    );
    return rows.map(mapRow);
  }

  async findBySlug(slug: string): Promise<Department | null> {
    const { rows } = await this.pool.query<DepartmentRow>(
      `SELECT * FROM department WHERE slug = $1`,
      [slug],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findById(id: string): Promise<Department | null> {
    const { rows } = await this.pool.query<DepartmentRow>(
      `SELECT * FROM department WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(input: CreateDepartmentInput): Promise<Department> {
    const { rows } = await this.pool.query<DepartmentRow>(
      `INSERT INTO department (slug, name, description, visibility) VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING *`,
      [input.slug, input.name, input.description ?? null, input.visibility ?? "shared"],
    );
    return mapRow(rows[0]!);
  }

  async update(id: string, input: UpdateDepartmentInput): Promise<Department> {
    const fields: string[] = [];
    const values: unknown[] = [id];
    let query = `UPDATE department SET `;

    if (input.name !== undefined) {
      values.push(input.name);
      fields.push(`name = $${values.length}`);
    }
    if (input.slug !== undefined) {
      values.push(input.slug);
      fields.push(`slug = $${values.length}`);
    }
    if (input.description !== undefined) {
      values.push(input.description);
      fields.push(`description = $${values.length}`);
    }
    if (input.visibility !== undefined) {
      values.push(input.visibility);
      fields.push(`visibility = $${values.length}`);
    }
    if (input.active !== undefined) {
      values.push(input.active);
      fields.push(`active = $${values.length}`);
    }

    if (fields.length === 0) {
      const current = await this.findById(id);
      if (!current) throw new Error("Department not found");
      return current;
    }

    query += fields.join(", ");
    query += ` WHERE id = $1 RETURNING *`;

    const { rows } = await this.pool.query<DepartmentRow>(query, values);
    if (!rows[0]) throw new Error("Department not found");
    return mapRow(rows[0]);
  }

  async deactivate(id: string): Promise<Department> {
    const { rows } = await this.pool.query<DepartmentRow>(
      `UPDATE department SET active = false WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!rows[0]) throw new Error("Department not found");
    return mapRow(rows[0]);
  }

  async hasActiveAgents(id: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) FROM agent WHERE primary_department_id = $1 AND active = true`,
      [id],
    );
    return parseInt(rows[0]!.count, 10) > 0;
  }

  async hasOpenCases(id: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) FROM "case" WHERE department_id = $1 AND status NOT IN ('COMPLETED', 'EXPIRED', 'CANCELLED')`,
      [id],
    );
    return parseInt(rows[0]!.count, 10) > 0;
  }

  // --- Enrutamiento de casos e intenciones ---

  async listRoutings(departmentId?: string): Promise<DepartmentCaseRouting[]> {
    if (departmentId) {
      const { rows } = await this.pool.query<RoutingRow>(
        `SELECT * FROM department_case_routing WHERE department_id = $1 ORDER BY label ASC`,
        [departmentId],
      );
      return rows.map(mapRoutingRow);
    }
    const { rows } = await this.pool.query<RoutingRow>(
      `SELECT * FROM department_case_routing ORDER BY label ASC`,
    );
    return rows.map(mapRoutingRow);
  }

  async createRouting(input: CreateDepartmentCaseRoutingInput): Promise<DepartmentCaseRouting> {
    const { rows } = await this.pool.query<RoutingRow>(
      `INSERT INTO department_case_routing (
        department_id, intent_key, label, description, handling_mode, workflow_type, active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (intent_key) DO UPDATE SET
        department_id = EXCLUDED.department_id,
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        handling_mode = EXCLUDED.handling_mode,
        workflow_type = EXCLUDED.workflow_type,
        active = EXCLUDED.active,
        updated_at = now()
      RETURNING *`,
      [
        input.departmentId,
        input.intentKey,
        input.label,
        input.description,
        input.handlingMode ?? "ai_assisted",
        input.workflowType ?? "GENERAL_INQUIRY",
        input.active ?? true,
      ],
    );
    return mapRoutingRow(rows[0]!);
  }

  async updateRouting(id: string, input: UpdateDepartmentCaseRoutingInput): Promise<DepartmentCaseRouting> {
    const fields: string[] = ["updated_at = now()"];
    const values: unknown[] = [id];

    if (input.label !== undefined) {
      values.push(input.label);
      fields.push(`label = $${values.length}`);
    }
    if (input.description !== undefined) {
      values.push(input.description);
      fields.push(`description = $${values.length}`);
    }
    if (input.intentKey !== undefined) {
      values.push(input.intentKey);
      fields.push(`intent_key = $${values.length}`);
    }
    if (input.handlingMode !== undefined) {
      values.push(input.handlingMode);
      fields.push(`handling_mode = $${values.length}`);
    }
    if (input.workflowType !== undefined) {
      values.push(input.workflowType);
      fields.push(`workflow_type = $${values.length}`);
    }
    if (input.active !== undefined) {
      values.push(input.active);
      fields.push(`active = $${values.length}`);
    }

    const { rows } = await this.pool.query<RoutingRow>(
      `UPDATE department_case_routing SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      values,
    );
    if (!rows[0]) throw new Error("Routing not found");
    return mapRoutingRow(rows[0]);
  }

  async deleteRouting(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM department_case_routing WHERE id = $1`, [id]);
  }

  async findRoutingByIntent(intentKey: string): Promise<DepartmentCaseRouting | null> {
    const { rows } = await this.pool.query<RoutingRow>(
      `SELECT * FROM department_case_routing WHERE intent_key = $1 AND active = true`,
      [intentKey],
    );
    return rows[0] ? mapRoutingRow(rows[0]) : null;
  }
}
