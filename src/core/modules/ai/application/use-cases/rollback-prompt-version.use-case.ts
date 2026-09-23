import { notFound, validation } from "../../../../../shared/errors/domain-errors";
import type { PromptVersion } from "../../domain/entities/prompt-version.entity";
import type { PromptTemplateRepositoryPort } from "../ports/prompt-template.repository.port";
import type { PromptResolverService } from "../services/prompt-resolver.service";

export interface RollbackPromptVersionInput {
  slug: string;
  targetVersionId?: string; // Si no se indica, regresa a la última versión anterior archivada
}

export class RollbackPromptVersionUseCase {
  constructor(
    private readonly promptRepo: PromptTemplateRepositoryPort,
    private readonly resolverService: PromptResolverService,
  ) {}

  async execute(input: RollbackPromptVersionInput): Promise<PromptVersion> {
    const template = await this.promptRepo.findBySlug(input.slug);
    if (!template) {
      throw notFound(`Plantilla de prompt '${input.slug}' no encontrada`);
    }

    let targetVersion: PromptVersion | null = null;

    if (input.targetVersionId) {
      targetVersion = await this.promptRepo.findVersionById(input.targetVersionId);
      if (!targetVersion || targetVersion.templateId !== template.id) {
        throw notFound(`Versión destino '${input.targetVersionId}' no pertenece a la plantilla '${input.slug}'`);
      }
    } else {
      // Buscar la última versión previa disponible
      const versions = await this.promptRepo.listVersions(template.id);
      const candidates = versions.filter((v) => v.id !== template.activeVersionId);
      if (candidates.length === 0 || !candidates[0]) {
        throw validation(`No hay versiones previas a las cuales revertir en '${input.slug}'`);
      }
      targetVersion = candidates[0]; // Ya ordenadas DESC por version_number
    }

    if (!targetVersion) {
      throw validation(`No hay versión válida para revertir en '${input.slug}'`);
    }

    await this.promptRepo.setActiveVersion(template.id, targetVersion.id);
    this.resolverService.invalidateCache(input.slug);

    const updated = await this.promptRepo.findVersionById(targetVersion.id);
    return updated!;
  }
}
