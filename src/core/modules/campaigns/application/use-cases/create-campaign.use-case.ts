import type { Campaign } from "../../domain/campaign.entity";
import type {
  CampaignRepositoryPort,
  CreateCampaignInput,
} from "../ports/campaign.repository.port";

export class CreateCampaignUseCase {
  constructor(private readonly campaignRepo: CampaignRepositoryPort) {}

  async execute(input: CreateCampaignInput): Promise<Campaign> {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error("El nombre de la campaña es requerido");
    }
    if (trimmedName.length > 50) {
      throw new Error("El nombre de la campaña no puede exceder 50 caracteres");
    }

    return this.campaignRepo.create({
      ...input,
      name: trimmedName,
      quickMode: input.quickMode ?? false,
      quickModeIntervalSeconds: input.quickModeIntervalSeconds ?? 45,
    });
  }
}
