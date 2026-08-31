import type { CampaignRecipient, RecipientStatus } from "../../domain/campaign-recipient.entity";

export type CreateRecipientInput = {
  phone: string;
  name?: string | null;
  customBody?: string | null;
};

export type RecipientCounts = {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
};

export interface CampaignRecipientRepositoryPort {
  bulkInsert(campaignId: string, recipients: CreateRecipientInput[]): Promise<number>;
  findPendingBatch(campaignId: string, limit: number): Promise<CampaignRecipient[]>;
  updateStatus(
    id: string,
    status: RecipientStatus,
    data?: { externalId?: string | null; errorMessage?: string | null; sentAt?: Date | null },
  ): Promise<CampaignRecipient>;
  countByCampaign(campaignId: string): Promise<RecipientCounts>;
  listByCampaignId(campaignId: string): Promise<CampaignRecipient[]>;
}
