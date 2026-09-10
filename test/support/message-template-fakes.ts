import { randomUUID } from "node:crypto";
import type {
  MessageTemplate,
  MessageTemplateStatus,
} from "../../src/core/modules/message-templates/domain/message-template.entity";
import type {
  ListMessageTemplatesFilter,
  ListMessageTemplatesResult,
  MessageTemplateRepositoryPort,
} from "../../src/core/modules/message-templates/application/ports/message-template.repository.port";
import type {
  FetchTemplateStatusResult,
  MetaTemplatesGatewayPort,
  SubmitTemplateInput,
  SubmitTemplateResult,
} from "../../src/core/modules/message-templates/application/ports/meta-templates-gateway.port";

export class MessageTemplateRepositoryFake implements MessageTemplateRepositoryPort {
  readonly templates = new Map<string, MessageTemplate>();

  seed(template: MessageTemplate): MessageTemplate {
    this.templates.set(template.id, template);
    return template;
  }

  async create(input: Omit<MessageTemplate, "createdAt" | "updatedAt">): Promise<MessageTemplate> {
    const now = new Date();
    const template: MessageTemplate = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(template.id, template);
    return template;
  }

  async findById(id: string): Promise<MessageTemplate | null> {
    return this.templates.get(id) ?? null;
  }

  async findByMetaTemplateId(metaTemplateId: string): Promise<MessageTemplate | null> {
    return [...this.templates.values()].find((t) => t.metaTemplateId === metaTemplateId) ?? null;
  }

  async findByName(name: string): Promise<MessageTemplate | null> {
    return [...this.templates.values()].find((t) => t.name === name) ?? null;
  }

  async list(filter: ListMessageTemplatesFilter): Promise<ListMessageTemplatesResult> {
    let result = [...this.templates.values()];

    if (filter.category) {
      result = result.filter((t) => t.category === filter.category);
    }
    if (filter.status) {
      result = result.filter((t) => t.status === filter.status);
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      result = result.filter(
        (t) => t.name.toLowerCase().includes(q) || t.bodyText.toLowerCase().includes(q),
      );
    }

    const total = result.length;
    const offset = filter.offset && filter.offset >= 0 ? filter.offset : 0;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;

    const paginated = result.slice(offset, offset + limit);
    return { templates: paginated, total };
  }

  async delete(id: string): Promise<boolean> {
    return this.templates.delete(id);
  }

  async updateStatus(
    id: string,
    status: MessageTemplateStatus,
    rejectedReason?: string | null,
  ): Promise<MessageTemplate> {
    const existing = this.templates.get(id);
    if (!existing) {
      throw new Error(`MessageTemplate '${id}' not found`);
    }
    const updated: MessageTemplate = {
      ...existing,
      status,
      rejectedReason: rejectedReason ?? null,
      updatedAt: new Date(),
    };
    this.templates.set(id, updated);
    return updated;
  }

  async updateMetaTemplateId(
    id: string,
    metaTemplateId: string,
    status?: MessageTemplateStatus,
  ): Promise<MessageTemplate> {
    const existing = this.templates.get(id);
    if (!existing) {
      throw new Error(`MessageTemplate '${id}' not found`);
    }
    const updated: MessageTemplate = {
      ...existing,
      metaTemplateId,
      status: status ?? existing.status,
      updatedAt: new Date(),
    };
    this.templates.set(id, updated);
    return updated;
  }
}

export class MetaTemplatesGatewayFake implements MetaTemplatesGatewayPort {
  readonly submitted: SubmitTemplateInput[] = [];
  readonly deleted: Array<{ metaTemplateId: string; name: string }> = [];
  readonly statusMap = new Map<
    string,
    { status: MessageTemplateStatus; rejectedReason?: string | null }
  >();

  async submitTemplate(template: SubmitTemplateInput): Promise<SubmitTemplateResult> {
    this.submitted.push(template);
    const metaTemplateId = `meta-${randomUUID().slice(0, 8)}`;
    return {
      metaTemplateId,
      status: "PENDING",
    };
  }

  async fetchTemplateStatus(metaTemplateId: string): Promise<FetchTemplateStatusResult> {
    const mapped = this.statusMap.get(metaTemplateId);
    if (mapped) {
      return {
        metaTemplateId,
        status: mapped.status,
        rejectedReason: mapped.rejectedReason ?? null,
      };
    }
    return {
      metaTemplateId,
      status: "APPROVED",
      rejectedReason: null,
    };
  }

  async deleteTemplate(metaTemplateId: string, name: string): Promise<boolean> {
    this.deleted.push({ metaTemplateId, name });
    return true;
  }
}
