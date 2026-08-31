import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";

export class DeleteCampaignUseCase {
  constructor(private readonly campaignRepo: CampaignRepositoryPort) {}

  async execute(id: string): Promise<boolean> {
    const campaign = await this.campaignRepo.findById(id);
    if (!campaign) {
      throw new Error(`Campaña ${id} no encontrada`);
    }

    if (campaign.status !== "DRAFT") {
      throw new Error(
        `Solo se pueden eliminar campañas en estado DRAFT (estado actual: ${campaign.status})`,
      );
    }

    return this.campaignRepo.delete(id);
  }
}
