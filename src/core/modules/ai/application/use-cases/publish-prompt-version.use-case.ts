import { notFound, validation } from "../../../../../shared/errors/domain-errors";
import type { PromptVersion } from "../../domain/entities/prompt-version.entity";
import type { PromptTemplateRepositoryPort } from "../ports/prompt-template.repository.port";
import type { PromptResolverService } from "../services/prompt-resolver.service";

export interface PublishPromptVersionInput {
  slug: string;
  versionId: string;
}

export class PublishPromptVersionUseCase {
  constructor(
    private readonly promptRepo: PromptTemplateRepositoryPort,
    private readonly resolverService: PromptResolverService,
  ) {}

  async execute(input: PublishPromptVersionInput): Promise<PromptVersion> {
    const template = await this.promptRepo.findBySlug(input.slug);
    if (!template) {
      throw notFound(`Plantilla de prompt '${input.slug}' no encontrada`);
    }

    const version = await this.promptRepo.findVersionById(input.versionId);
    if (!version || version.templateId !== template.id) {
      throw notFound(`Versión '${input.versionId}' no encontrada en la plantilla '${input.slug}'`);
    }

    await this.promptRepo.setActiveVersion(template.id, version.id);
    this.resolverService.invalidateCache(input.slug);

    const updated = await this.promptRepo.findVersionById(input.versionId);
    if (!updated) {
      throw validation("Fallo al recuperar la versión recién publicada");
    }

    return updated;
  }
}
