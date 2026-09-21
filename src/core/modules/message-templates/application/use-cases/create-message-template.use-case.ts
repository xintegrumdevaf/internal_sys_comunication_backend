import { randomUUID } from "node:crypto";
import { businessError, validationError } from "../../../../../shared/errors/domain-errors";
import type {
  MessageTemplate,
  MessageTemplateCategory,
  MessageTemplateHeaderType,
  TemplateButton,
} from "../../domain/message-template.entity";
import type { MessageTemplateRepositoryPort } from "../ports/message-template.repository.port";
import type { MetaTemplatesGatewayPort } from "../ports/meta-templates-gateway.port";

import { TemplatePolicyValidator } from "../../domain/template-policy-validator";

export interface CreateMessageTemplateInput {
  name: string;
  category: MessageTemplateCategory;
  language?: string;
  headerType?: MessageTemplateHeaderType;
  headerContent?: string | null;
  bodyText: string;
  footerText?: string | null;
  buttons?: TemplateButton[] | null;
}

export type CreateMessageTemplateDeps = {
  templateRepo: MessageTemplateRepositoryPort;
  metaGateway: MetaTemplatesGatewayPort;
};

export class CreateMessageTemplateUseCase {
  constructor(private readonly deps: CreateMessageTemplateDeps) {}

  async execute(input: CreateMessageTemplateInput): Promise<MessageTemplate> {
    const name = input.name ? input.name.trim() : "";
    const bodyText = input.bodyText ? input.bodyText.trim() : "";
    if (!bodyText) {
      throw validationError("El texto del cuerpo (bodyText) es requerido");
    }

    const language = input.language?.trim() || "es";
    const headerType = input.headerType || "NONE";
    const headerContent = input.headerContent ? input.headerContent.trim() : null;
    const footerText = input.footerText ?? null;
    const buttons = input.buttons ?? null;

    // Ejecutar todas las validaciones de políticas Meta (sintaxis nombre, variables 1..N, límites y acortadores)
    TemplatePolicyValidator.validateAll({
      name,
      category: input.category,
      language,
      headerType,
      headerContent,
      bodyText,
      footerText,
      buttons,
    });

    if (
      (headerType === "IMAGE" || headerType === "VIDEO" || headerType === "DOCUMENT") &&
      !headerContent
    ) {
      throw validationError(
        `Debes proporcionar un enlace o ID de recurso de ejemplo en el encabezado (headerContent) para plantillas de tipo ${headerType}`,
      );
    }

    const existing = await this.deps.templateRepo.findByName(name);
    if (existing) {
      if (existing.metaTemplateId === null) {
        await this.deps.templateRepo.delete(existing.id);
      } else {
        throw businessError(`Ya existe una plantilla con el nombre '${name}'`);
      }
    }

    const id = randomUUID();
    const initialTemplate = await this.deps.templateRepo.create({
      id,
      name,
      category: input.category,
      language,
      headerType,
      headerContent,
      bodyText,
      footerText,
      buttons,
      status: "PENDING",
      metaTemplateId: null,
      rejectedReason: null,
    });

    try {
      const metaResult = await this.deps.metaGateway.submitTemplate({
        name,
        category: input.category,
        language,
        headerType,
        headerContent,
        bodyText,
        footerText,
        buttons,
      });

      return await this.deps.templateRepo.updateMetaTemplateId(
        initialTemplate.id,
        metaResult.metaTemplateId,
        metaResult.status,
      );
    } catch (error) {
      await this.deps.templateRepo.delete(initialTemplate.id).catch(() => {});
      throw error;
    }
  }
}
