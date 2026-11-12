import type { Pool } from "pg";
import type { Conversation, ConversationStatus } from "../../domain/conversation.entity";
import type {
  ConversationRepositoryPort,
  ConversationSearchMatch,
  ListConversationsFilter,
} from "../../application/ports/conversation.repository.port";
import type { MessageAuthor } from "../../domain/message.entity";

type ConversationRow = {
  id: string;
  wa_phone: string;
  customer_id: string | null;
  customer_name?: string | null;
  active_case_id: string | null;
  status: ConversationStatus;
  last_activity_at: Date;
  created_at: Date;
  updated_at: Date;
  wa_profile_name: string | null;
  unread_count: number;
};

function mapRow(row: ConversationRow): Conversation {
  return {
    id: row.id,
    waPhone: row.wa_phone,
    customerId: row.customer_id,
    customerName: row.customer_name ?? null,
    activeCaseId: row.active_case_id,
    status: row.status,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    waProfileName: row.wa_profile_name,
    unreadCount: row.unread_count,
  };
}

export class ConversationRepositoryPg implements ConversationRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT c.*, cust.full_name AS customer_name
       FROM conversation c
       LEFT JOIN customer cust ON c.customer_id = cust.id OR (c.customer_id IS NULL AND c.wa_phone = cust.wa_phone)
       WHERE c.id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByWaPhone(waPhone: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT c.*, cust.full_name AS customer_name
       FROM conversation c
       LEFT JOIN customer cust ON c.customer_id = cust.id OR (c.customer_id IS NULL AND c.wa_phone = cust.wa_phone)
       WHERE c.wa_phone = $1
       ORDER BY c.created_at ASC
       LIMIT 1`,
      [waPhone],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findOrCreateByWaPhone(waPhone: string): Promise<Conversation> {
    let existing = await this.findByWaPhone(waPhone);
    if (existing) {
      return existing;
    }

    try {
      const { rows } = await this.pool.query<ConversationRow>(
        `INSERT INTO conversation (wa_phone) VALUES ($1) RETURNING *`,
        [waPhone],
      );
      return mapRow(rows[0]!);
    } catch {
      existing = await this.findByWaPhone(waPhone);
      if (existing) {
        return existing;
      }
      throw new Error(`No se pudo crear ni recuperar la conversacion para el telefono ${waPhone}`);
    }
  }

  async touchLastActivity(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversation SET last_activity_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  async setLastActivityAt(id: string, date: Date): Promise<void> {
    await this.pool.query(
      `UPDATE conversation SET last_activity_at = $2, updated_at = now() WHERE id = $1`,
      [id, date],
    );
  }

  async incrementUnreadCount(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversation SET unread_count = unread_count + 1, updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  async resetUnreadCount(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversation SET unread_count = 0, updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  async setActiveCaseId(id: string, caseId: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE conversation SET active_case_id = $2, updated_at = now() WHERE id = $1`,
      [id, caseId],
    );
  }

  async setCustomerId(id: string, customerId: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE conversation SET customer_id = $2, updated_at = now() WHERE id = $1`,
      [id, customerId],
    );
  }

  async setWaProfileName(id: string, name: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversation SET wa_profile_name = $2, updated_at = now() WHERE id = $1`,
      [id, name],
    );
  }

  async setStatus(id: string, status: ConversationStatus): Promise<void> {
    await this.pool.query(
      `UPDATE conversation SET status = $2, updated_at = now() WHERE id = $1`,
      [id, status],
    );
  }

  async list(filter: ListConversationsFilter): Promise<Conversation[]> {
    const baseQuery = `
      SELECT c.*, cust.full_name AS customer_name
      FROM conversation c
      LEFT JOIN customer cust ON c.customer_id = cust.id OR (c.customer_id IS NULL AND c.wa_phone = cust.wa_phone)
    `;
    if (filter.status) {
      const { rows } = await this.pool.query<ConversationRow>(
        `${baseQuery} WHERE c.status = $1 ORDER BY c.last_activity_at DESC`,
        [filter.status],
      );
      return rows.map(mapRow);
    }

    const { rows } = await this.pool.query<ConversationRow>(
      `${baseQuery} ORDER BY c.last_activity_at DESC`,
    );
    return rows.map(mapRow);
  }

  async search(query: string, options?: { limit?: number }): Promise<ConversationSearchMatch[]> {
    const cleanQ = query.trim();
    if (!cleanQ) return [];
    const limit = Math.min(options?.limit ?? 25, 50);

    const sql = `
      SELECT
        c.*,
        cust.full_name AS customer_name,
        m.id AS matched_message_id,
        m.body AS matched_message_body,
        m.author AS matched_message_author,
        m.created_at AS matched_message_created_at
      FROM conversation c
      LEFT JOIN customer cust ON c.customer_id = cust.id OR (c.customer_id IS NULL AND c.wa_phone = cust.wa_phone)
      LEFT JOIN LATERAL (
        SELECT m1.id, m1.body, m1.author, m1.created_at
        FROM message m1
        WHERE m1.conversation_id = c.id
          AND m1.author != 'system'
          AND m1.body ILIKE ('%' || $1 || '%')
        ORDER BY m1.created_at DESC
        LIMIT 1
      ) m ON true
      WHERE
        c.wa_phone ILIKE ('%' || $1 || '%')
        OR c.wa_profile_name ILIKE ('%' || $1 || '%')
        OR cust.full_name ILIKE ('%' || $1 || '%')
        OR cust.national_id ILIKE ('%' || $1 || '%')
        OR m.id IS NOT NULL
      ORDER BY COALESCE(m.created_at, c.last_activity_at) DESC
      LIMIT $2
    `;

    const { rows } = await this.pool.query<
      ConversationRow & {
        matched_message_id?: string | null;
        matched_message_body?: string | null;
        matched_message_author?: MessageAuthor | null;
        matched_message_created_at?: Date | null;
      }
    >(sql, [cleanQ, limit]);

    return rows.map((row) => ({
      conversation: mapRow(row),
      matchedMessage: row.matched_message_id
        ? {
            id: row.matched_message_id,
            body: row.matched_message_body ?? "",
            author: row.matched_message_author ?? "customer",
            createdAt: row.matched_message_created_at ?? row.created_at,
          }
        : null,
    }));
  }
}
