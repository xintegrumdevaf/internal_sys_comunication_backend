import type { Campaign } from "../../domain/campaign.entity";
import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";
import type { CampaignRecipientRepositoryPort } from "../ports/campaign-recipient.repository.port";

export interface CampaignQueuePort {
  enqueueCampaignJob(campaignId: string): Promise<void>;
}

export class StartCampaignUseCase {
  constructor(
    private readonly campaignRepo: CampaignRepositoryPort,
    private readonly recipientRepo: CampaignRecipientRepositoryPort,
    private readonly queue: CampaignQueuePort,
  ) {}

  async execute(campaignId: string): Promise<Campaign> {
    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) {
      throw new Error(`Campaña ${campaignId} no encontrada`);
    }

    const counts = await this.recipientRepo.countByCampaign(campaignId);

    if (campaign.status === "COMPLETED" || campaign.status === "FAILED") {
      if (counts.failed > 0 && counts.sent > 0) {
        await this.recipientRepo.resetRecipientsToPending(campaignId, true);
        await this.campaignRepo.resetCounters(campaignId, { resetFailed: true });
      } else {
        await this.recipientRepo.resetRecipientsToPending(campaignId, false);
        await this.campaignRepo.resetCounters(campaignId, { resetSent: true, resetFailed: true });
      }
    } else if (campaign.status !== "DRAFT" && campaign.status !== "SUSPENDED") {
      throw new Error(
        `No se puede iniciar una campaña en estado ${campaign.status}. Debe estar en DRAFT, SUSPENDED, COMPLETED o FAILED`,
      );
    }

    const updatedCounts = await this.recipientRepo.countByCampaign(campaignId);
    if (updatedCounts.pending === 0 && updatedCounts.total === 0) {
      throw new Error("La campaña debe tener al menos un destinatario para poder ser iniciada");
    }

    const startedAt = new Date();
    const updated = await this.campaignRepo.updateStatus(campaignId, "RUNNING", { startedAt });

    await this.queue.enqueueCampaignJob(campaignId);

    return updated;
  }
}
