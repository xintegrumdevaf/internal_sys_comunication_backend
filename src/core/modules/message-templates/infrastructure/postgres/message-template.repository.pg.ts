import type { Pool } from "pg";
import type {
  MessageTemplate,
  MessageTemplateCategory,
  MessageTemplateHeaderType,
  MessageTemplateStatus,
  TemplateButton,
} from "../../domain/message-template.entity";
import type {
  ListMessageTemplatesFilter,
  ListMessageTemplatesResult,
  MessageTemplateRepositoryPort,
} from "../../application/ports/message-template.repository.port";

type Row = {
  id: string;
  name: string;
  category: MessageTemplateCategory;
  language: string;
  header_type: MessageTemplateHeaderType;
  header_content: string | null;
  body_text: string;
  footer_text: string | null;
  buttons: TemplateButton[] | null;
  status: MessageTemplateStatus;
  meta_template_id: string | null;
  rejected_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: Row): MessageTemplate {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    language: row.language,
    headerType: row.header_type,
    headerContent: row.header_content,
    bodyText: row.body_text,
    footerText: row.footer_text,
    buttons: row.buttons ? (typeof row.buttons === "string" ? JSON.parse(row.buttons) : row.buttons) : null,
    status: row.status,
    metaTemplateId: row.meta_template_id,
    rejectedReason: row.rejected_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MessageTemplateRepositoryPg implements MessageTemplateRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async create(input: Omit<MessageTemplate, "createdAt" | "updatedAt">): Promise<MessageTemplate> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO message_templates (
        id, name, category, language, header_type,
        header_content, body_text, footer_text, buttons, status,
        meta_template_id, rejected_reason, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
      RETURNING *`,
      [
        input.id,
        input.name,
        input.category,
        input.language,
        input.headerType,
        input.headerContent,
        input.bodyText,
        input.footerText,
        input.buttons ? JSON.stringify(input.buttons) : null,
        input.status,
        input.metaTemplateId,
        input.rejectedReason,
      ],
    );
    return mapRow(rows[0]!);
  }

  async findById(id: string): Promise<MessageTemplate | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM message_templates WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByMetaTemplateId(metaTemplateId: string): Promise<MessageTemplate | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM message_templates WHERE meta_template_id = $1`,
      [metaTemplateId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByName(name: string): Promise<MessageTemplate | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM message_templates WHERE name = $1`,
      [name],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async list(filter: ListMessageTemplatesFilter): Promise<ListMessageTemplatesResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.category) {
      values.push(filter.category);
      conditions.push(`category = $${values.length}`);
    }

    if (filter.status) {
      values.push(filter.status);
      conditions.push(`status = $${values.length}`);
    }

    if (filter.search) {
      values.push(`%${filter.search}%`);
      conditions.push(`(name ILIKE $${values.length} OR body_text ILIKE $${values.length})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*)::int as total FROM message_templates ${whereClause}`;
    const countResult = await this.pool.query<{ total: number }>(countQuery, values);
    const total = countResult.rows[0]?.total ?? 0;

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    const offset = filter.offset && filter.offset >= 0 ? filter.offset : 0;

    values.push(limit);
    const limitIdx = values.length;
    values.push(offset);
    const offsetIdx = values.length;

    const dataQuery = `
      SELECT * FROM message_templates
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const { rows } = await this.pool.query<Row>(dataQuery, values);
    return {
      templates: rows.map(mapRow),
      total,
    };
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM message_templates WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateStatus(
    id: string,
    status: MessageTemplateStatus,
    rejectedReason?: string | null,
  ): Promise<MessageTemplate> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE message_templates
       SET status = $2, rejected_reason = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, status, rejectedReason ?? null],
    );
    if (!rows[0]) {
      throw new Error(`MessageTemplate con ID '${id}' no encontrado`);
    }
    return mapRow(rows[0]);
  }

  async updateMetaTemplateId(
    id: string,
    metaTemplateId: string,
    status?: MessageTemplateStatus,
  ): Promise<MessageTemplate> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE message_templates
       SET meta_template_id = $2,
           status = COALESCE($3, status),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, metaTemplateId, status ?? null],
    );
    if (!rows[0]) {
      throw new Error(`MessageTemplate con ID '${id}' no encontrado`);
    }
    return mapRow(rows[0]);
  }
}
