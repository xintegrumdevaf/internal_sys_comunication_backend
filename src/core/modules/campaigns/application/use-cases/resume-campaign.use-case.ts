import type { Campaign } from "../../domain/campaign.entity";
import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";
import type { CampaignQueuePort } from "./start-campaign.use-case";

export class ResumeCampaignUseCase {
  constructor(
    private readonly campaignRepo: CampaignRepositoryPort,
    private readonly queue: CampaignQueuePort,
  ) {}

  async execute(campaignId: string): Promise<Campaign> {
    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) {
      throw new Error(`Campaña ${campaignId} no encontrada`);
    }

    if (campaign.status !== "SUSPENDED") {
      throw new Error(`Solo se pueden reanudar campañas en estado SUSPENDED (estado actual: ${campaign.status})`);
    }

    const updated = await this.campaignRepo.updateStatus(campaignId, "RUNNING");
    await this.queue.enqueueCampaignJob(campaignId);

    return updated;
  }
}
