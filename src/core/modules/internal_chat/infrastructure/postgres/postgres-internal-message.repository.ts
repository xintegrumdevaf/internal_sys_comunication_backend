import type { Pool } from "pg";
import type {
  InternalMessage,
  InternalMessageType,
} from "../../domain/entities/internal-message.entity";
import type {
  CreateInternalMessageInput,
  InternalMessageRepositoryPort,
  ListInternalMessagesOptions,
} from "../../domain/ports/internal-message.repository.port";

export class PostgresInternalMessageRepository implements InternalMessageRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateInternalMessageInput): Promise<InternalMessage> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{
        id: string;
        thread_id: string;
        sender_agent_id: string;
        type: InternalMessageType;
        body: string;
        context_data: Record<string, unknown>;
        created_at: Date;
      }>(
        `INSERT INTO internal_message (thread_id, sender_agent_id, type, body, context_data)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, thread_id, sender_agent_id, type, body, context_data, created_at`,
        [
          input.threadId,
          input.senderAgentId,
          input.type ?? "text",
          input.body,
          JSON.stringify(input.contextData ?? {}),
        ]
      );

      const row = rows[0];
      if (!row) {
        throw new Error("No se pudo insertar el mensaje interno");
      }

      await client.query(
        `UPDATE internal_thread
         SET updated_at = $2
         WHERE id = $1`,
        [input.threadId, row.created_at]
      );

      await client.query("COMMIT");

      return {
        id: row.id,
        threadId: row.thread_id,
        senderAgentId: row.sender_agent_id,
        type: row.type,
        body: row.body,
        contextData: row.context_data ?? {},
        createdAt: row.created_at,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listByThread(
    threadId: string,
    options: ListInternalMessagesOptions = {}
  ): Promise<{ messages: InternalMessage[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const params: unknown[] = [threadId, limit + 1];

    let cursorClause = "";
    if (options.cursor) {
      params.push(new Date(options.cursor));
      cursorClause = `AND m.created_at < $3`;
    }

    // Fetches the most recent `limit + 1` messages (or before cursor)
    const { rows } = await this.pool.query<{
      id: string;
      thread_id: string;
      sender_agent_id: string;
      sender_agent_name: string;
      type: InternalMessageType;
      body: string;
      context_data: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT 
         m.id,
         m.thread_id,
         m.sender_agent_id,
         a.name AS sender_agent_name,
         m.type,
         m.body,
         m.context_data,
         m.created_at
       FROM internal_message m
       JOIN agent a ON a.id = m.sender_agent_id
       WHERE m.thread_id = $1 ${cursorClause}
       ORDER BY m.created_at DESC
       LIMIT $2`,
      params
    );

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;

    const lastItem = slice[slice.length - 1];
    const nextCursor =
      hasMore && lastItem ? lastItem.created_at.toISOString() : null;

    // Return in chronological order (oldest to newest)
    const messages: InternalMessage[] = slice.reverse().map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      senderAgentId: r.sender_agent_id,
      senderAgentName: r.sender_agent_name,
      type: r.type,
      body: r.body,
      contextData: r.context_data ?? {},
      createdAt: r.created_at,
    }));

    return { messages, nextCursor };
  }
}
