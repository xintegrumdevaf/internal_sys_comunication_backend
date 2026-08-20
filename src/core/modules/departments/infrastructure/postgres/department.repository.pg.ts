import type { Pool } from "pg";
import type { Department, DepartmentVisibility } from "../../domain/department.entity";
import type {
  CreateDepartmentInput,
  UpdateDepartmentInput,
  DepartmentRepositoryPort,
} from "../../application/ports/department.repository.port";

type DepartmentRow = {
  id: string;
  slug: string;
  name: string;
  visibility: DepartmentVisibility;
  active: boolean;
  created_at: Date;
};

function mapRow(row: DepartmentRow): Department {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    visibility: row.visibility,
    active: row.active,
    createdAt: row.created_at,
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
      `INSERT INTO department (slug, name, visibility) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [input.slug, input.name, input.visibility ?? "shared"],
    );
    return mapRow(rows[0]!);
  }
  async update(id: string, input: UpdateDepartmentInput): Promise<Department> {
    const fields: string[] = [];
    const values: any[] = [id];
    let query = `UPDATE department SET `;

    if (input.name !== undefined) {
      values.push(input.name);
      fields.push(`name = $${values.length}`);
    }
    if (input.slug !== undefined) {
      values.push(input.slug);
      fields.push(`slug = $${values.length}`);
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
      // Nothing to update, just return the current state
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
      `SELECT count(*) FROM case_record WHERE department_id = $1 AND status NOT IN ('COMPLETED', 'EXPIRED', 'CANCELLED')`,
      [id],
    );
    return parseInt(rows[0]!.count, 10) > 0;
  }
}
