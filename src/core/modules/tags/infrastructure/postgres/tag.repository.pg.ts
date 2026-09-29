import type { Pool } from "pg";
import type { Tag } from "../../domain/tag.entity";
import type { CreateTagInput, TagRepositoryPort, UpdateTagInput } from "../../application/ports/tag.repository.port";

type TagRow = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapRowToEntity(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TagRepositoryPg implements TagRepositoryPort {
  constructor(private readonly db: Pool) {}

  async findAll(includeInactive = false): Promise<Tag[]> {
    const query = includeInactive
      ? `SELECT id, name, description, color, active, created_at, updated_at FROM tag ORDER BY name ASC`
      : `SELECT id, name, description, color, active, created_at, updated_at FROM tag WHERE active = true ORDER BY name ASC`;
    const res = await this.db.query<TagRow>(query);
    return res.rows.map(mapRowToEntity);
  }

  async findById(id: string): Promise<Tag | null> {
    const res = await this.db.query<TagRow>(
      `SELECT id, name, description, color, active, created_at, updated_at FROM tag WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? mapRowToEntity(res.rows[0]) : null;
  }

  async findByName(name: string): Promise<Tag | null> {
    const res = await this.db.query<TagRow>(
      `SELECT id, name, description, color, active, created_at, updated_at FROM tag WHERE UPPER(name) = UPPER($1)`,
      [name],
    );
    return res.rows[0] ? mapRowToEntity(res.rows[0]) : null;
  }

  async create(input: CreateTagInput): Promise<Tag> {
    const res = await this.db.query<TagRow>(
      `INSERT INTO tag (name, description, color)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, color, active, created_at, updated_at`,
      [input.name.trim().toUpperCase(), input.description ?? null, input.color ?? null],
    );
    return mapRowToEntity(res.rows[0]!);
  }

  async update(id: string, input: UpdateTagInput): Promise<Tag | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(input.name.trim().toUpperCase());
    }
    if (input.description !== undefined) {
      fields.push(`description = $${idx++}`);
      values.push(input.description);
    }
    if (input.color !== undefined) {
      fields.push(`color = $${idx++}`);
      values.push(input.color);
    }
    if (input.active !== undefined) {
      fields.push(`active = $${idx++}`);
      values.push(input.active);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push(`updated_at = now()`);
    values.push(id);

    const res = await this.db.query<TagRow>(
      `UPDATE tag SET ${fields.join(", ")} WHERE id = $${idx} RETURNING id, name, description, color, active, created_at, updated_at`,
      values,
    );
    return res.rows[0] ? mapRowToEntity(res.rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM tag WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
