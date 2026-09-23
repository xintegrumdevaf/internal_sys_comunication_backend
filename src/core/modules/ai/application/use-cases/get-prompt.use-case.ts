import { notFound } from "../../../../../shared/errors/domain-errors";
import type { PromptTemplate } from "../../domain/entities/prompt-template.entity";
import type { PromptVersion } from "../../domain/entities/prompt-version.entity";
import type { PromptTemplateRepositoryPort } from "../ports/prompt-template.repository.port";

export interface GetPromptDetailResult {
  template: PromptTemplate;
  activeVersion: PromptVersion | null;
  versions: PromptVersion[];
}

export class GetPromptUseCase {
  constructor(private readonly promptRepo: PromptTemplateRepositoryPort) {}

  async execute(slug: string): Promise<GetPromptDetailResult> {
    const template = await this.promptRepo.findBySlug(slug);
    if (!template) {
      throw notFound(`Plantilla de prompt con slug '${slug}' no encontrada`);
    }

    const versions = await this.promptRepo.listVersions(template.id);
    const activeVersion = versions.find((v) => v.id === template.activeVersionId) ?? null;

    return {
      template,
      activeVersion,
      versions,
    };
  }
}
