import type { MessageTemplateRepositoryPort } from "../../message-templates/application/ports/message-template.repository.port";

export class CreateCampaignUseCase {
  constructor(
    private readonly campaignRepo: CampaignRepositoryPort,
    private readonly messageTemplateRepo?: MessageTemplateRepositoryPort,
  ) {}

  async execute(input: CreateCampaignInput): Promise<Campaign> {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error("El nombre de la campaña es requerido");
    }
    if (trimmedName.length > 50) {
      throw new Error("El nombre de la campaña no puede exceder 50 caracteres");
    }

    let templateLanguage = input.templateLanguage;
    if (input.templateName && (!templateLanguage || templateLanguage.trim().length === 0)) {
      if (this.messageTemplateRepo) {
        const found = await this.messageTemplateRepo.findByName(input.templateName.trim());
        if (found?.language) {
          templateLanguage = found.language;
        }
      }
    }

    return this.campaignRepo.create({
      ...input,
      name: trimmedName,
      templateLanguage: templateLanguage ?? input.templateLanguage,
      quickMode: input.quickMode ?? false,
      quickModeIntervalSeconds: input.quickModeIntervalSeconds ?? 45,
    });
  }
}
