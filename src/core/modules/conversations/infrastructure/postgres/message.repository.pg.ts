import type { Pool } from "pg";
import type { Message, MessageAuthor } from "../../domain/message.entity";
import type {
  InsertInboundMessageInput,
  InsertOutboundMessageInput,
  MessageRepositoryPort,
} from "../../application/ports/message.repository.port";

type MessageRow = {
  id: string;
  conversation_id: string;
  case_id: string | null;
  direction: "inbound" | "outbound";
  author: MessageAuthor;
  external_id: string | null;
  body: string;
  type: string;
  media_id: string | null;
  mime_type: string | null;
  caption: string | null;
  filename: string | null;
  created_at: Date;
};

function mapRow(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    caseId: row.case_id,
    direction: row.direction,
    author: row.author,
    externalId: row.external_id,
    body: row.body,
    type: row.type,
    mediaId: row.media_id,
    mimeType: row.mime_type,
    caption: row.caption,
    filename: row.filename,
    createdAt: row.created_at,
  };
}

export class MessageRepositoryPg implements MessageRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async insertInbound(
    input: InsertInboundMessageInput,
  ): Promise<{ message: Message; isDuplicate: boolean }> {
    const inserted = await this.pool.query<MessageRow>(
      `INSERT INTO message (conversation_id, direction, author, external_id, body, type, media_id, mime_type, caption, filename)
       VALUES ($1, 'inbound', 'customer', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (conversation_id, external_id) DO NOTHING
       RETURNING *`,
      [
        input.conversationId,
        input.externalId,
        input.body,
        input.type,
        input.mediaId ?? null,
        input.mimeType ?? null,
        input.caption ?? null,
        input.filename ?? null,
      ],
    );

    if (inserted.rows[0]) {
      return { message: mapRow(inserted.rows[0]), isDuplicate: false };
    }

    // UNIQUE(conversation_id, external_id) — el mensaje ya existia (reintento de Meta).
    const existing = await this.pool.query<MessageRow>(
      `SELECT * FROM message WHERE conversation_id = $1 AND external_id = $2`,
      [input.conversationId, input.externalId],
    );
    return { message: mapRow(existing.rows[0]!), isDuplicate: true };
  }

  async insertOutbound(input: InsertOutboundMessageInput): Promise<Message> {
    const { rows } = await this.pool.query<MessageRow>(
      `INSERT INTO message (conversation_id, direction, author, external_id, body, type)
       VALUES ($1, 'outbound', $2, $3, $4, 'text')
       RETURNING *`,
      [input.conversationId, input.author, input.externalId ?? null, input.body],
    );
    return mapRow(rows[0]!);
  }

  async listByConversation(
    conversationId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Message[]> {
    const params: unknown[] = [conversationId];
    const clauses = [`conversation_id = $1`];
    if (options.cursor) {
      params.push(new Date(options.cursor));
      clauses.push(`created_at < $${params.length}`);
    }
    let sql = `SELECT * FROM message WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`;
    if (options.limit && options.limit > 0) {
      // Pedimos los últimos N: orden DESC + limit + reverse.
      sql = `SELECT * FROM (
               SELECT * FROM message WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length + 1}
             ) m ORDER BY created_at ASC`;
      params.push(options.limit);
    }
    const { rows } = await this.pool.query<MessageRow>(sql, params);
    return rows.map(mapRow);
  }

  async findByIds(ids: string[]): Promise<Message[]> {
    if (ids.length === 0) {
      return [];
    }
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM message WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC`,
      [ids],
    );
    return rows.map(mapRow);
  }

  async findLastByConversationIds(conversationIds: string[]): Promise<Map<string, Message>> {
    const result = new Map<string, Message>();
    if (conversationIds.length === 0) return result;
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT DISTINCT ON (conversation_id) *
       FROM message
       WHERE conversation_id = ANY($1::uuid[])
       ORDER BY conversation_id, created_at DESC`,
      [conversationIds],
    );
    for (const row of rows) {
      result.set(row.conversation_id, mapRow(row));
    }
    return result;
  }
}
