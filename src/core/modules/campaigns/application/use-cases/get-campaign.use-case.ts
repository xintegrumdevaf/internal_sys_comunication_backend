import type { Campaign } from "../../domain/campaign.entity";
import type { CampaignRecipient } from "../../domain/campaign-recipient.entity";
import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";
import type { CampaignRecipientRepositoryPort } from "../ports/campaign-recipient.repository.port";

export type CampaignDetail = Campaign & {
  progress: number;
  recipients: CampaignRecipient[];
};

export class GetCampaignUseCase {
  constructor(
    private readonly campaignRepo: CampaignRepositoryPort,
    private readonly recipientRepo: CampaignRecipientRepositoryPort,
  ) {}

  async execute(id: string): Promise<CampaignDetail | null> {
    const campaign = await this.campaignRepo.findById(id);
    if (!campaign) return null;

    const recipients = await this.recipientRepo.listByCampaignId(id);

    const progress =
      campaign.totalRecipients > 0
        ? Math.round((campaign.sentCount / campaign.totalRecipients) * 100)
        : 0;

    return {
      ...campaign,
      progress,
      recipients,
    };
  }
}
