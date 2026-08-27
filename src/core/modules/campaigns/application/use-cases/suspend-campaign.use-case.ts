import type { Campaign } from "../../domain/campaign.entity";
import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";

export class SuspendCampaignUseCase {
  constructor(private readonly campaignRepo: CampaignRepositoryPort) {}

  async execute(campaignId: string): Promise<Campaign> {
    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) {
      throw new Error(`Campaña ${campaignId} no encontrada`);
    }

    if (campaign.status !== "RUNNING") {
      throw new Error(`Solo se pueden suspender campañas en estado RUNNING (estado actual: ${campaign.status})`);
    }

    return this.campaignRepo.updateStatus(campaignId, "SUSPENDED");
  }
}
