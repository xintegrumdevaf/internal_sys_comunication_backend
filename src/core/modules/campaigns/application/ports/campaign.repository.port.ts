import type {
  Campaign,
  CampaignChatRouting,
  CampaignContactEnrichment,
  CampaignStatus,
} from "../../domain/campaign.entity";

export type CreateCampaignInput = {
  name: string;
  messageBody?: string;
  quickMode?: boolean;
  quickModeIntervalSeconds?: number;
  chatRouting?: Partial<CampaignChatRouting>;
  contactEnrichment?: Partial<CampaignContactEnrichment>;
};

export type ListCampaignsFilter = {
  search?: string;
  status?: CampaignStatus;
};

export interface CampaignRepositoryPort {
  create(input: CreateCampaignInput): Promise<Campaign>;
  findById(id: string): Promise<Campaign | null>;
  list(filter: ListCampaignsFilter): Promise<Campaign[]>;
  updateStatus(
    id: string,
    status: CampaignStatus,
    dates?: { startedAt?: Date; completedAt?: Date },
  ): Promise<Campaign>;
  incrementCounters(
    id: string,
    counters: { sent?: number; failed?: number },
  ): Promise<void>;
  updateTotalRecipients(id: string, total: number): Promise<void>;
  delete(id: string): Promise<boolean>;
}
