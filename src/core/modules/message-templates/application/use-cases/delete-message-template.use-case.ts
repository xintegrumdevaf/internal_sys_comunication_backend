import { notFound } from "../../../../../shared/errors/domain-errors";
import type { MessageTemplateRepositoryPort } from "../ports/message-template.repository.port";
import type { MetaTemplatesGatewayPort } from "../ports/meta-templates-gateway.port";

export type DeleteMessageTemplateDeps = {
  templateRepo: MessageTemplateRepositoryPort;
  metaGateway: MetaTemplatesGatewayPort;
};

export class DeleteMessageTemplateUseCase {
  constructor(private readonly deps: DeleteMessageTemplateDeps) {}

  async execute(id: string): Promise<{ success: boolean; id: string }> {
    const template = await this.deps.templateRepo.findById(id);
    if (!template) {
      throw notFound(`Plantilla de mensaje con ID '${id}' no encontrada`);
    }

    if (template.metaTemplateId) {
      try {
        await this.deps.metaGateway.deleteTemplate(template.metaTemplateId, template.name);
      } catch (error) {
        // Se intenta borrar de Meta; si falla, se procede con el borrado local
      }
    }

    await this.deps.templateRepo.delete(id);
    return { success: true, id };
  }
}
