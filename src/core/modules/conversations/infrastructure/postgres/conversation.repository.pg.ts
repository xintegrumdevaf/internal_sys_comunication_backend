import type { Pool } from "pg";
import type { Conversation, ConversationStatus } from "../../domain/conversation.entity";
import type {
  ConversationRepositoryPort,
  ListConversationsFilter,
} from "../../application/ports/conversation.repository.port";

type ConversationRow = {
  id: string;
  wa_phone: string;
  customer_id: string | null;
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
      `SELECT * FROM conversation WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByWaPhone(waPhone: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT * FROM conversation WHERE wa_phone = $1 ORDER BY created_at ASC LIMIT 1`,
      [waPhone],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findOrCreateByWaPhone(waPhone: string): Promise<Conversation> {
    const existing = await this.findByWaPhone(waPhone);
    if (existing) {
      return existing;
    }

    const { rows } = await this.pool.query<ConversationRow>(
      `INSERT INTO conversation (wa_phone) VALUES ($1) RETURNING *`,
      [waPhone],
    );
    return mapRow(rows[0]!);
  }

  async touchLastActivity(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversation SET last_activity_at = now(), updated_at = now() WHERE id = $1`,
      [id],
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
    if (filter.status) {
      const { rows } = await this.pool.query<ConversationRow>(
        `SELECT * FROM conversation WHERE status = $1 ORDER BY last_activity_at DESC`,
        [filter.status],
      );
      return rows.map(mapRow);
    }

    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT * FROM conversation ORDER BY last_activity_at DESC`,
    );
    return rows.map(mapRow);
  }
}
