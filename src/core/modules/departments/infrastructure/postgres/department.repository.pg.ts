import type { Pool } from "pg";
import type { Department } from "../../domain/department.entity";
import type {
  CreateDepartmentInput,
  DepartmentRepositoryPort,
} from "../../application/ports/department.repository.port";

type DepartmentRow = {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  created_at: Date;
};

function mapRow(row: DepartmentRow): Department {
  return { id: row.id, slug: row.slug, name: row.name, active: row.active, createdAt: row.created_at };
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

  async create(input: CreateDepartmentInput): Promise<Department> {
    const { rows } = await this.pool.query<DepartmentRow>(
      `INSERT INTO department (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [input.slug, input.name],
    );
    return mapRow(rows[0]!);
  }
}
