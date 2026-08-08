import type { Pool } from "pg";
import type { Department, DepartmentVisibility } from "../../domain/department.entity";
import type {
  CreateDepartmentInput,
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
}
