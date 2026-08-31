import type { Campaign } from "../../domain/campaign.entity";
import type {
  CampaignRepositoryPort,
  ListCampaignsFilter,
} from "../ports/campaign.repository.port";

export type CampaignWithProgress = Campaign & {
  progress: number;
};

export class ListCampaignsUseCase {
  constructor(private readonly campaignRepo: CampaignRepositoryPort) {}

  async execute(filter: ListCampaignsFilter = {}): Promise<CampaignWithProgress[]> {
    const campaigns = await this.campaignRepo.list(filter);

    return campaigns.map((campaign) => {
      const progress =
        campaign.totalRecipients > 0
          ? Math.round((campaign.sentCount / campaign.totalRecipients) * 100)
          : 0;

      return {
        ...campaign,
        progress,
      };
    });
  }
}
