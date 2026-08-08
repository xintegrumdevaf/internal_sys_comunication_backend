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

  async listByConversation(conversationId: string): Promise<Message[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM message WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    );
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
}
