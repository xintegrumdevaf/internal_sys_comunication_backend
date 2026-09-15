import type { Pool } from "pg";
import type { QuickReply, QuickReplyFilter } from "../../domain/quick-reply.entity";
import type { QuickReplyRepositoryPort } from "../../application/ports/quick-reply.repository.port";

type QuickReplyRow = {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  department_id: string | null;
  category: string | null;
  media_url: string | null;
  created_by_agent_id: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: QuickReplyRow): QuickReply {
  return {
    id: row.id,
    shortcut: row.shortcut,
    title: row.title,
    body: row.body,
    departmentId: row.department_id,
    category: row.category,
    mediaUrl: row.media_url,
    createdByAgentId: row.created_by_agent_id,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class QuickReplyRepositoryPg implements QuickReplyRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<QuickReply | null> {
    const res = await this.pool.query<QuickReplyRow>(
      `SELECT * FROM quick_reply WHERE id = $1 LIMIT 1`,
      [id],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async findByShortcut(shortcut: string, departmentId: string | null): Promise<QuickReply | null> {
    if (departmentId === null) {
      const res = await this.pool.query<QuickReplyRow>(
        `SELECT * FROM quick_reply WHERE LOWER(shortcut) = LOWER($1) AND department_id IS NULL LIMIT 1`,
        [shortcut],
      );
      return res.rows[0] ? mapRow(res.rows[0]) : null;
    }

    const res = await this.pool.query<QuickReplyRow>(
      `SELECT * FROM quick_reply WHERE LOWER(shortcut) = LOWER($1) AND department_id = $2 LIMIT 1`,
      [shortcut, departmentId],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async list(filter?: QuickReplyFilter): Promise<QuickReply[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.departmentIds !== undefined) {
      const hasNull = filter.departmentIds.includes(null);
      const nonNullIds = filter.departmentIds.filter((id): id is string => id !== null);

      if (hasNull && nonNullIds.length > 0) {
        params.push(nonNullIds);
        conditions.push(`(department_id IS NULL OR department_id = ANY($${params.length}))`);
      } else if (hasNull) {
        conditions.push(`department_id IS NULL`);
      } else if (nonNullIds.length > 0) {
        params.push(nonNullIds);
        conditions.push(`department_id = ANY($${params.length})`);
      } else {
        conditions.push(`1 = 0`);
      }
    }

    if (filter?.activeOnly) {
      conditions.push(`active = true`);
    }

    if (filter?.category) {
      params.push(filter.category);
      conditions.push(`category = $${params.length}`);
    }

    if (filter?.search) {
      params.push(`%${filter.search.toLowerCase()}%`);
      const pIdx = params.length;
      conditions.push(
        `(LOWER(shortcut) LIKE $${pIdx} OR LOWER(title) LIKE $${pIdx} OR LOWER(body) LIKE $${pIdx})`,
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const res = await this.pool.query<QuickReplyRow>(
      `SELECT * FROM quick_reply ${whereClause} ORDER BY shortcut ASC`,
      params,
    );

    return res.rows.map(mapRow);
  }

  async save(reply: QuickReply): Promise<void> {
    await this.pool.query(
      `INSERT INTO quick_reply (
        id, shortcut, title, body, department_id, category, media_url,
        created_by_agent_id, active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        shortcut = EXCLUDED.shortcut,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        department_id = EXCLUDED.department_id,
        category = EXCLUDED.category,
        media_url = EXCLUDED.media_url,
        active = EXCLUDED.active,
        updated_at = EXCLUDED.updated_at`,
      [
        reply.id,
        reply.shortcut,
        reply.title,
        reply.body,
        reply.departmentId,
        reply.category,
        reply.mediaUrl,
        reply.createdByAgentId,
        reply.active,
        reply.createdAt,
        reply.updatedAt,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM quick_reply WHERE id = $1`, [id]);
  }
}
