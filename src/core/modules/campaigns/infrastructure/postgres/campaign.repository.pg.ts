import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  Campaign,
  CampaignChatRouting,
  CampaignContactEnrichment,
  CampaignStatus,
} from "../../domain/campaign.entity";
import type {
  CampaignRecipient,
  RecipientStatus,
} from "../../domain/campaign-recipient.entity";
import type {
  CampaignRepositoryPort,
  CreateCampaignInput,
  ListCampaignsFilter,
} from "../../application/ports/campaign.repository.port";
import type {
  CampaignRecipientRepositoryPort,
  CreateRecipientInput,
  RecipientCounts,
} from "../../application/ports/campaign-recipient.repository.port";

type CampaignRow = {
  id: string;
  name: string;
  status: CampaignStatus;
  message_body: string;
  quick_mode: boolean;
  quick_mode_interval_seconds: number;
  chat_routing: CampaignChatRouting;
  contact_enrichment: CampaignContactEnrichment;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  template_name: string | null;
  template_language: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

type RecipientRow = {
  id: string;
  campaign_id: string;
  phone: string;
  name: string | null;
  custom_body: string | null;
  status: RecipientStatus;
  external_id: string | null;
  error_message: string | null;
  sent_at: Date | null;
};

function mapCampaignRow(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    messageBody: row.message_body,
    quickMode: row.quick_mode,
    quickModeIntervalSeconds: Number(row.quick_mode_interval_seconds),
    chatRouting: row.chat_routing ?? {
      initialStatus: "OPEN",
      departmentId: null,
      assignedAgentId: null,
      keepAssignedToUser: false,
      delegateToBot: false,
      forceChatUpdate: false,
    },
    contactEnrichment: row.contact_enrichment ?? {
      tagIds: [],
      additionalFields: {},
      forceUpdateContactData: false,
    },
    totalRecipients: Number(row.total_recipients),
    sentCount: Number(row.sent_count),
    failedCount: Number(row.failed_count),
    templateName: row.template_name,
    templateLanguage: row.template_language,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapRecipientRow(row: RecipientRow): CampaignRecipient {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    phone: row.phone,
    name: row.name,
    customBody: row.custom_body,
    status: row.status,
    externalId: row.external_id,
    errorMessage: row.error_message,
    sentAt: row.sent_at,
  };
}

export class CampaignRepositoryPg implements CampaignRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateCampaignInput): Promise<Campaign> {
    const defaultChatRouting: CampaignChatRouting = {
      initialStatus: "OPEN",
      departmentId: null,
      assignedAgentId: null,
      keepAssignedToUser: false,
      delegateToBot: false,
      forceChatUpdate: false,
      ...input.chatRouting,
    };

    const defaultContactEnrichment: CampaignContactEnrichment = {
      tagIds: [],
      additionalFields: {},
      forceUpdateContactData: false,
      ...input.contactEnrichment,
    };

    const { rows } = await this.pool.query<CampaignRow>(
      `INSERT INTO campaign (
        name, message_body, quick_mode, quick_mode_interval_seconds,
        chat_routing, contact_enrichment, status, template_name, template_language
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'DRAFT', $7, $8)
      RETURNING *`,
      [
        input.name,
        input.messageBody ?? "",
        input.quickMode ?? false,
        input.quickModeIntervalSeconds ?? 45,
        JSON.stringify(defaultChatRouting),
        JSON.stringify(defaultContactEnrichment),
        input.templateName ?? null,
        input.templateLanguage ?? "es",
      ],
    );

    return mapCampaignRow(rows[0]!);
  }

  async findById(id: string): Promise<Campaign | null> {
    const { rows } = await this.pool.query<CampaignRow>(
      `SELECT * FROM campaign WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapCampaignRow(rows[0]) : null;
  }

  async list(filter: ListCampaignsFilter): Promise<Campaign[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.search) {
      params.push(`%${filter.search}%`);
      clauses.push(`name ILIKE $${params.length}`);
    }

    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query<CampaignRow>(
      `SELECT * FROM campaign ${where} ORDER BY created_at DESC`,
      params,
    );

    return rows.map(mapCampaignRow);
  }

  async updateStatus(
    id: string,
    status: CampaignStatus,
    dates?: { startedAt?: Date; completedAt?: Date },
  ): Promise<Campaign> {
    const updates: string[] = ["status = $2"];
    const params: unknown[] = [id, status];

    if (dates?.startedAt !== undefined) {
      params.push(dates.startedAt);
      updates.push(`started_at = $${params.length}`);
    }

    if (dates?.completedAt !== undefined) {
      params.push(dates.completedAt);
      updates.push(`completed_at = $${params.length}`);
    }

    const { rows } = await this.pool.query<CampaignRow>(
      `UPDATE campaign SET ${updates.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );

    if (!rows[0]) {
      throw new Error(`Campaña ${id} no encontrada para actualización de estado`);
    }

    return mapCampaignRow(rows[0]);
  }

  async incrementCounters(
    id: string,
    counters: { sent?: number; failed?: number },
  ): Promise<void> {
    const sentInc = counters.sent ?? 0;
    const failedInc = counters.failed ?? 0;

    await this.pool.query(
      `UPDATE campaign
       SET sent_count = sent_count + $2,
           failed_count = failed_count + $3
       WHERE id = $1`,
      [id, sentInc, failedInc],
    );
  }

  async resetCounters(
    id: string,
    options: { resetSent?: boolean; resetFailed?: boolean },
  ): Promise<void> {
    const updates: string[] = ["completed_at = NULL"];
    if (options.resetSent) updates.push("sent_count = 0");
    if (options.resetFailed) updates.push("failed_count = 0");

    await this.pool.query(
      `UPDATE campaign SET ${updates.join(", ")} WHERE id = $1`,
      [id],
    );
  }

  async updateTotalRecipients(id: string, total: number): Promise<void> {
    await this.pool.query(`UPDATE campaign SET total_recipients = $2 WHERE id = $1`, [
      id,
      total,
    ]);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM campaign WHERE id = $1`, [
      id,
    ]);
    return (rowCount ?? 0) > 0;
  }
}

export class CampaignRecipientRepositoryPg implements CampaignRecipientRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async bulkInsert(campaignId: string, recipients: CreateRecipientInput[]): Promise<number> {
    if (recipients.length === 0) return 0;

    const values: unknown[] = [];
    const valueTuples: string[] = [];

    let paramIdx = 1;
    for (const r of recipients) {
      valueTuples.push(
        `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, 'PENDING')`,
      );
      values.push(campaignId, r.phone, r.name ?? null, r.customBody ?? null);
      paramIdx += 4;
    }

    const { rowCount } = await this.pool.query(
      `INSERT INTO campaign_recipient (campaign_id, phone, name, custom_body, status)
       VALUES ${valueTuples.join(", ")}`,
      values,
    );

    return rowCount ?? recipients.length;
  }

  async findPendingBatch(campaignId: string, limit: number): Promise<CampaignRecipient[]> {
    const { rows } = await this.pool.query<RecipientRow>(
      `SELECT * FROM campaign_recipient
       WHERE campaign_id = $1 AND status = 'PENDING'
       ORDER BY id ASC
       LIMIT $2`,
      [campaignId, limit],
    );

    return rows.map(mapRecipientRow);
  }

  async updateStatus(
    id: string,
    status: RecipientStatus,
    data?: { externalId?: string | null; errorMessage?: string | null; sentAt?: Date | null },
  ): Promise<CampaignRecipient> {
    const { rows } = await this.pool.query<RecipientRow>(
      `UPDATE campaign_recipient
       SET status = $2,
           external_id = COALESCE($3, external_id),
           error_message = COALESCE($4, error_message),
           sent_at = COALESCE($5, sent_at)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        status,
        data?.externalId ?? null,
        data?.errorMessage ?? null,
        data?.sentAt ?? null,
      ],
    );

    if (!rows[0]) {
      throw new Error(`Destinatario ${id} no encontrado`);
    }

    return mapRecipientRow(rows[0]);
  }

  async resetRecipientsToPending(campaignId: string, onlyFailed = false): Promise<number> {
    const whereStatus = onlyFailed ? "AND status = 'FAILED'" : "";
    const { rowCount } = await this.pool.query(
      `UPDATE campaign_recipient
       SET status = 'PENDING',
           error_message = NULL,
           external_id = NULL,
           sent_at = NULL
       WHERE campaign_id = $1 ${whereStatus}`,
      [campaignId],
    );
    return rowCount ?? 0;
  }

  async countByCampaign(campaignId: string): Promise<RecipientCounts> {
    const { rows } = await this.pool.query<{ status: RecipientStatus; count: string }>(
      `SELECT status, COUNT(*) as count FROM campaign_recipient
       WHERE campaign_id = $1
       GROUP BY status`,
      [campaignId],
    );

    const counts: RecipientCounts = {
      total: 0,
      pending: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    };

    for (const row of rows) {
      const c = Number(row.count);
      counts.total += c;
      if (row.status === "PENDING") counts.pending = c;
      if (row.status === "SENT") counts.sent = c;
      if (row.status === "FAILED") counts.failed = c;
      if (row.status === "SKIPPED") counts.skipped = c;
    }

    return counts;
  }

  async listByCampaignId(campaignId: string): Promise<CampaignRecipient[]> {
    const { rows } = await this.pool.query<RecipientRow>(
      `SELECT * FROM campaign_recipient WHERE campaign_id = $1 ORDER BY id ASC`,
      [campaignId],
    );

    return rows.map(mapRecipientRow);
  }
}

/** Fake en memoria para tests de Campaign. */
export class CampaignRepositoryFake implements CampaignRepositoryPort {
  readonly items = new Map<string, Campaign>();

  async create(input: CreateCampaignInput): Promise<Campaign> {
    const campaign: Campaign = {
      id: randomUUID(),
      name: input.name,
      status: "DRAFT",
      messageBody: input.messageBody ?? "",
      quickMode: input.quickMode ?? false,
      quickModeIntervalSeconds: input.quickModeIntervalSeconds ?? 45,
      chatRouting: {
        initialStatus: "OPEN",
        departmentId: null,
        assignedAgentId: null,
        keepAssignedToUser: false,
        delegateToBot: false,
        forceChatUpdate: false,
        ...input.chatRouting,
      },
      contactEnrichment: {
        tagIds: [],
        additionalFields: {},
        forceUpdateContactData: false,
        ...input.contactEnrichment,
      },
      totalRecipients: 0,
      sentCount: 0,
      failedCount: 0,
      templateName: input.templateName ?? null,
      templateLanguage: input.templateLanguage ?? "es",
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };

    this.items.set(campaign.id, campaign);
    return campaign;
  }

  async findById(id: string): Promise<Campaign | null> {
    return this.items.get(id) ?? null;
  }

  async list(filter: ListCampaignsFilter): Promise<Campaign[]> {
    return [...this.items.values()].filter((c) => {
      if (filter.search && !c.name.toLowerCase().includes(filter.search.toLowerCase())) {
        return false;
      }
      if (filter.status && c.status !== filter.status) {
        return false;
      }
      return true;
    });
  }

  async updateStatus(
    id: string,
    status: CampaignStatus,
    dates?: { startedAt?: Date; completedAt?: Date },
  ): Promise<Campaign> {
    const existing = this.items.get(id);
    if (!existing) throw new Error(`Campaña fake ${id} no encontrada`);

    const updated: Campaign = {
      ...existing,
      status,
      startedAt: dates?.startedAt !== undefined ? dates.startedAt : existing.startedAt,
      completedAt: dates?.completedAt !== undefined ? dates.completedAt : existing.completedAt,
    };

    this.items.set(id, updated);
    return updated;
  }

  async incrementCounters(
    id: string,
    counters: { sent?: number; failed?: number },
  ): Promise<void> {
    const existing = this.items.get(id);
    if (!existing) return;

    existing.sentCount += counters.sent ?? 0;
    existing.failedCount += counters.failed ?? 0;
    this.items.set(id, existing);
  }

  async resetCounters(
    id: string,
    options: { resetSent?: boolean; resetFailed?: boolean },
  ): Promise<void> {
    const existing = this.items.get(id);
    if (!existing) return;

    if (options.resetSent) existing.sentCount = 0;
    if (options.resetFailed) existing.failedCount = 0;
    existing.completedAt = null;
    this.items.set(id, existing);
  }

  async updateTotalRecipients(id: string, total: number): Promise<void> {
    const existing = this.items.get(id);
    if (!existing) return;

    existing.totalRecipients = total;
    this.items.set(id, existing);
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
}

/** Fake en memoria para tests de CampaignRecipient. */
export class CampaignRecipientRepositoryFake implements CampaignRecipientRepositoryPort {
  readonly items = new Map<string, CampaignRecipient>();

  async bulkInsert(campaignId: string, recipients: CreateRecipientInput[]): Promise<number> {
    let inserted = 0;
    for (const r of recipients) {
      const recipient: CampaignRecipient = {
        id: randomUUID(),
        campaignId,
        phone: r.phone,
        name: r.name ?? null,
        customBody: r.customBody ?? null,
        status: "PENDING",
        externalId: null,
        errorMessage: null,
        sentAt: null,
      };
      this.items.set(recipient.id, recipient);
      inserted++;
    }
    return inserted;
  }

  async findPendingBatch(campaignId: string, limit: number): Promise<CampaignRecipient[]> {
    return [...this.items.values()]
      .filter((r) => r.campaignId === campaignId && r.status === "PENDING")
      .slice(0, limit);
  }

  async updateStatus(
    id: string,
    status: RecipientStatus,
    data?: { externalId?: string | null; errorMessage?: string | null; sentAt?: Date | null },
  ): Promise<CampaignRecipient> {
    const existing = this.items.get(id);
    if (!existing) throw new Error(`Destinatario fake ${id} no encontrado`);

    const updated: CampaignRecipient = {
      ...existing,
      status,
      externalId: data?.externalId !== undefined ? data.externalId : existing.externalId,
      errorMessage: data?.errorMessage !== undefined ? data.errorMessage : existing.errorMessage,
      sentAt: data?.sentAt !== undefined ? data.sentAt : existing.sentAt,
    };

    this.items.set(id, updated);
    return updated;
  }

  async resetRecipientsToPending(campaignId: string, onlyFailed = false): Promise<number> {
    let count = 0;
    for (const [id, item] of this.items.entries()) {
      if (item.campaignId === campaignId) {
        if (!onlyFailed || item.status === "FAILED") {
          this.items.set(id, {
            ...item,
            status: "PENDING",
            errorMessage: null,
            externalId: null,
            sentAt: null,
          });
          count++;
        }
      }
    }
    return count;
  }

  async countByCampaign(campaignId: string): Promise<RecipientCounts> {
    const list = [...this.items.values()].filter((r) => r.campaignId === campaignId);
    return {
      total: list.length,
      pending: list.filter((r) => r.status === "PENDING").length,
      sent: list.filter((r) => r.status === "SENT").length,
      failed: list.filter((r) => r.status === "FAILED").length,
      skipped: list.filter((r) => r.status === "SKIPPED").length,
    };
  }

  async listByCampaignId(campaignId: string): Promise<CampaignRecipient[]> {
    return [...this.items.values()].filter((r) => r.campaignId === campaignId);
  }
}
