import { randomUUID } from "node:crypto";
import type { MessageTemplate } from "../../domain/message-template.entity";
import type { MessageTemplateRepositoryPort } from "../ports/message-template.repository.port";
import type { MetaTemplatesGatewayPort } from "../ports/meta-templates-gateway.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export interface SyncRemoteTemplatesOutput {
  syncedCount: number;
  createdCount: number;
  updatedCount: number;
  templates: MessageTemplate[];
}

export type SyncRemoteTemplatesDeps = {
  templateRepo: MessageTemplateRepositoryPort;
  metaGateway: MetaTemplatesGatewayPort;
  broadcaster: RealtimeBroadcaster;
};

export class SyncRemoteTemplatesUseCase {
  constructor(private readonly deps: SyncRemoteTemplatesDeps) {}

  async execute(): Promise<SyncRemoteTemplatesOutput> {
    if (!this.deps.metaGateway.fetchAllTemplates) {
      const templatesResult = await this.deps.templateRepo.list({});
      return {
        syncedCount: 0,
        createdCount: 0,
        updatedCount: 0,
        templates: templatesResult.templates,
      };
    }

    const remoteTemplates = await this.deps.metaGateway.fetchAllTemplates();
    let createdCount = 0;
    let updatedCount = 0;
    const resultTemplates: MessageTemplate[] = [];

    for (const remote of remoteTemplates) {
      if (!remote.name) continue;

      const existing = await this.deps.templateRepo.findByName(remote.name);
      if (existing) {
        if (remote.metaTemplateId && remote.metaTemplateId !== existing.metaTemplateId) {
          await this.deps.templateRepo.updateMetaTemplateId(existing.id, remote.metaTemplateId, remote.status);
        }
        const updated = await this.deps.templateRepo.updateStatus(
          existing.id,
          remote.status,
          remote.rejectedReason ?? null,
        );
        updatedCount++;
        resultTemplates.push(updated);
      } else {
        const created = await this.deps.templateRepo.create({
          id: randomUUID(),
          name: remote.name,
          category: remote.category,
          language: remote.language,
          headerType: remote.headerType,
          headerContent: remote.headerContent ?? null,
          bodyText: remote.bodyText,
          footerText: remote.footerText ?? null,
          buttons: remote.buttons ?? null,
          metaTemplateId: remote.metaTemplateId,
          status: remote.status,
          rejectedReason: remote.rejectedReason ?? null,
        });
        createdCount++;
        resultTemplates.push(created);
      }
    }

    // Eliminar plantillas locales que ya no existen en Zernio/Meta
    const remoteNames = new Set(remoteTemplates.map((r) => r.name).filter(Boolean));
    const allLocal = await this.deps.templateRepo.list({ limit: 500 });
    for (const local of allLocal.templates) {
      if (!remoteNames.has(local.name)) {
        await this.deps.templateRepo.delete(local.id);
      }
    }

    this.deps.broadcaster.publish({
      type: "MESSAGE_TEMPLATES_SYNCED",
      syncedCount: remoteTemplates.length,
      createdCount,
      updatedCount,
    });

    return {
      syncedCount: remoteTemplates.length,
      createdCount,
      updatedCount,
      templates: resultTemplates,
    };
  }
}
