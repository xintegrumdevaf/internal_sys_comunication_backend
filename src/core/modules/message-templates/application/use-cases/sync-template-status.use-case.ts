import { notFound } from "../../../../../shared/errors/domain-errors";
import type { MessageTemplate, MessageTemplateStatus } from "../../domain/message-template.entity";
import type { MessageTemplateRepositoryPort } from "../ports/message-template.repository.port";
import type { MetaTemplatesGatewayPort } from "../ports/meta-templates-gateway.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export interface SyncTemplateStatusInput {
  id?: string;
  metaTemplateId?: string;
  name?: string;
  status?: MessageTemplateStatus;
  rejectedReason?: string | null;
}

export type SyncTemplateStatusDeps = {
  templateRepo: MessageTemplateRepositoryPort;
  metaGateway: MetaTemplatesGatewayPort;
  broadcaster: RealtimeBroadcaster;
};

export class SyncTemplateStatusUseCase {
  constructor(private readonly deps: SyncTemplateStatusDeps) {}

  async execute(input: SyncTemplateStatusInput): Promise<MessageTemplate> {
    let template: MessageTemplate | null = null;

    if (input.id) {
      template = await this.deps.templateRepo.findById(input.id);
    } else if (input.metaTemplateId) {
      template = await this.deps.templateRepo.findByMetaTemplateId(input.metaTemplateId);
    } else if (input.name) {
      template = await this.deps.templateRepo.findByName(input.name);
    }

    if (!template) {
      throw notFound("Plantilla de mensaje no encontrada para sincronización");
    }

    let targetStatus: MessageTemplateStatus = input.status ?? template.status;
    let targetReason: string | null = input.rejectedReason ?? template.rejectedReason;

    if (!input.status && template.metaTemplateId) {
      const fetched = await this.deps.metaGateway.fetchTemplateStatus(template.metaTemplateId);
      targetStatus = fetched.status;
      targetReason = fetched.rejectedReason ?? null;
    }

    const updated = await this.deps.templateRepo.updateStatus(
      template.id,
      targetStatus,
      targetReason,
    );

    this.deps.broadcaster.publish({
      type: "MESSAGE_TEMPLATE_UPDATED",
      templateId: updated.id,
      metaTemplateId: updated.metaTemplateId,
      status: updated.status,
      rejectedReason: updated.rejectedReason,
    });

    return updated;
  }
}
