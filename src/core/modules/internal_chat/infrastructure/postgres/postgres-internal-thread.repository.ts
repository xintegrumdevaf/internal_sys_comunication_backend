import type { Pool } from "pg";
import type {
  InternalThread,
  InternalThreadParticipant,
} from "../../domain/entities/internal-thread.entity";
import type {
  InternalThreadRepositoryPort,
  ThreadWithMetadata,
} from "../../domain/ports/internal-thread.repository.port";

export class PostgresInternalThreadRepository implements InternalThreadRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<InternalThread | null> {
    const { rows } = await this.pool.query<{
      id: string;
      type: "direct" | "group" | "quality_coaching";
      reference_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, type, reference_id, created_at, updated_at
       FROM internal_thread
       WHERE id = $1`,
      [id]
    );

    if (!rows[0]) return null;

    const participants = await this.getParticipantsForThread(id);

    return {
      id: rows[0].id,
      type: rows[0].type,
      referenceId: rows[0].reference_id,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
      participants,
    };
  }

  async findDirectThreadBetween(agentAId: string, agentBId: string): Promise<InternalThread | null> {
    const { rows } = await this.pool.query<{
      id: string;
      type: "direct" | "group" | "quality_coaching";
      reference_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT t.id, t.type, t.reference_id, t.created_at, t.updated_at
       FROM internal_thread t
       JOIN internal_thread_participant p1 ON p1.thread_id = t.id AND p1.agent_id = $1
       JOIN internal_thread_participant p2 ON p2.thread_id = t.id AND p2.agent_id = $2
       WHERE t.type = 'direct'
       LIMIT 1`,
      [agentAId, agentBId]
    );

    if (!rows[0]) return null;

    const participants = await this.getParticipantsForThread(rows[0].id);

    return {
      id: rows[0].id,
      type: rows[0].type,
      referenceId: rows[0].reference_id,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
      participants,
    };
  }

  async createDirectThread(
    agentAId: string,
    agentBId: string,
    referenceId?: string | null
  ): Promise<InternalThread> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: threadRows } = await client.query<{
        id: string;
        type: "direct" | "group" | "quality_coaching";
        reference_id: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO internal_thread (type, reference_id)
         VALUES ('direct', $1)
         RETURNING id, type, reference_id, created_at, updated_at`,
        [referenceId ?? null]
      );

      const thread = threadRows[0];
      if (!thread) {
        throw new Error("No se pudo crear el hilo directo");
      }

      await client.query(
        `INSERT INTO internal_thread_participant (thread_id, agent_id, last_read_at)
         VALUES ($1, $2, now()), ($1, $3, '1970-01-01 00:00:00Z')`,
        [thread.id, agentAId, agentBId]
      );

      await client.query("COMMIT");

      const participants = await this.getParticipantsForThread(thread.id);

      return {
        id: thread.id,
        type: thread.type,
        referenceId: thread.reference_id,
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
        participants,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listThreadsForAgent(agentId: string): Promise<ThreadWithMetadata[]> {
    const { rows } = await this.pool.query<{
      thread_id: string;
      type: "direct" | "group" | "quality_coaching";
      reference_id: string | null;
      created_at: Date;
      updated_at: Date;
      unread_count: string;
      last_message_id: string | null;
      last_message_sender_id: string | null;
      last_message_sender_name: string | null;
      last_message_type: "text" | "quality_quote" | "conversation_excerpt" | null;
      last_message_body: string | null;
      last_message_created_at: Date | null;
    }>(
      `SELECT 
         t.id AS thread_id,
         t.type,
         t.reference_id,
         t.created_at,
         t.updated_at,
         (
           SELECT COUNT(*)
           FROM internal_message m
           WHERE m.thread_id = t.id
             AND m.created_at > p.last_read_at
             AND m.sender_agent_id != $1
         ) AS unread_count,
         lm.id AS last_message_id,
         lm.sender_agent_id AS last_message_sender_id,
         la.name AS last_message_sender_name,
         lm.type AS last_message_type,
         lm.body AS last_message_body,
         lm.created_at AS last_message_created_at
       FROM internal_thread t
       JOIN internal_thread_participant p ON p.thread_id = t.id AND p.agent_id = $1
       LEFT JOIN LATERAL (
         SELECT m.id, m.sender_agent_id, m.type, m.body, m.created_at
         FROM internal_message m
         WHERE m.thread_id = t.id
         ORDER BY m.created_at DESC
         LIMIT 1
       ) lm ON TRUE
       LEFT JOIN agent la ON la.id = lm.sender_agent_id
       ORDER BY t.updated_at DESC`,
      [agentId]
    );

    const result: ThreadWithMetadata[] = [];

    for (const row of rows) {
      const participants = await this.getParticipantsForThread(row.thread_id);

      result.push({
        id: row.thread_id,
        type: row.type,
        referenceId: row.reference_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        participants,
        unreadCount: Number.parseInt(row.unread_count, 10) || 0,
        lastMessage: row.last_message_id
          ? {
              id: row.last_message_id,
              threadId: row.thread_id,
              senderAgentId: row.last_message_sender_id ?? "",
              senderAgentName: row.last_message_sender_name ?? "",
              type: row.last_message_type ?? "text",
              body: row.last_message_body ?? "",
              contextData: {},
              createdAt: row.last_message_created_at ?? new Date(),
            }
          : null,
      });
    }

    return result;
  }

  async isParticipant(threadId: string, agentId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM internal_thread_participant
       WHERE thread_id = $1 AND agent_id = $2`,
      [threadId, agentId]
    );

    return Number.parseInt(rows[0]?.count ?? "0", 10) > 0;
  }

  async getParticipantAgentIds(threadId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ agent_id: string }>(
      `SELECT agent_id
       FROM internal_thread_participant
       WHERE thread_id = $1`,
      [threadId]
    );

    return rows.map((r) => r.agent_id);
  }

  async markThreadRead(threadId: string, agentId: string, readAt: Date = new Date()): Promise<void> {
    await this.pool.query(
      `UPDATE internal_thread_participant
       SET last_read_at = $3
       WHERE thread_id = $1 AND agent_id = $2`,
      [threadId, agentId, readAt]
    );
  }

  private async getParticipantsForThread(threadId: string): Promise<InternalThreadParticipant[]> {
    const { rows } = await this.pool.query<{
      thread_id: string;
      agent_id: string;
      agent_name: string;
      agent_email: string;
      agent_role: "agent" | "manager" | "admin";
      last_read_at: Date;
    }>(
      `SELECT 
         p.thread_id,
         p.agent_id,
         a.name AS agent_name,
         a.email AS agent_email,
         a.role AS agent_role,
         p.last_read_at
       FROM internal_thread_participant p
       JOIN agent a ON a.id = p.agent_id
       WHERE p.thread_id = $1
       ORDER BY a.name ASC`,
      [threadId]
    );

    return rows.map((r) => ({
      threadId: r.thread_id,
      agentId: r.agent_id,
      agentName: r.agent_name,
      agentEmail: r.agent_email,
      agentRole: r.agent_role,
      lastReadAt: r.last_read_at,
    }));
  }
}
