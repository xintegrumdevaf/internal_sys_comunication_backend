import { notFound, validation } from "../../../../../shared/errors/domain-errors";
import type { PromptModelConfig, PromptVersion } from "../../domain/entities/prompt-version.entity";
import type { PromptTemplateRepositoryPort } from "../ports/prompt-template.repository.port";
import type { PromptResolverService } from "../services/prompt-resolver.service";

export interface SavePromptVersionInput {
  slug: string;
  systemPrompt: string;
  userTemplate: string;
  modelConfig?: PromptModelConfig;
  changeNotes?: string;
  createdBy?: string;
  publishImmediately?: boolean;
}

export class SavePromptVersionUseCase {
  constructor(
    private readonly promptRepo: PromptTemplateRepositoryPort,
    private readonly resolverService: PromptResolverService,
  ) {}

  async execute(input: SavePromptVersionInput): Promise<PromptVersion> {
    const template = await this.promptRepo.findBySlug(input.slug);
    if (!template) {
      throw notFound(`Plantilla de prompt '${input.slug}' no encontrada`);
    }

    if (!input.systemPrompt || input.systemPrompt.trim() === "") {
      throw validation("El systemPrompt es obligatorio");
    }

    if (!input.userTemplate || input.userTemplate.trim() === "") {
      throw validation("El userTemplate es obligatorio");
    }

    const version = await this.promptRepo.createVersion({
      templateId: template.id,
      systemPrompt: input.systemPrompt,
      userTemplate: input.userTemplate,
      modelConfig: input.modelConfig,
      changeNotes: input.changeNotes,
      createdBy: input.createdBy,
      status: input.publishImmediately ? "PUBLISHED" : "DRAFT",
    });

    this.resolverService.invalidateCache(input.slug);
    return version;
  }
}
