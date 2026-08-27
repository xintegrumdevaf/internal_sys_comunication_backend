import type {
  MessageTemplate,
  MessageTemplateCategory,
  MessageTemplateStatus,
} from "../../domain/message-template.entity";

export interface ListMessageTemplatesFilter {
  category?: MessageTemplateCategory;
  status?: MessageTemplateStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListMessageTemplatesResult {
  templates: MessageTemplate[];
  total: number;
}

export interface MessageTemplateRepositoryPort {
  create(input: Omit<MessageTemplate, "createdAt" | "updatedAt">): Promise<MessageTemplate>;
  findById(id: string): Promise<MessageTemplate | null>;
  findByMetaTemplateId(metaTemplateId: string): Promise<MessageTemplate | null>;
  findByName(name: string): Promise<MessageTemplate | null>;
  list(filter: ListMessageTemplatesFilter): Promise<ListMessageTemplatesResult>;
  delete(id: string): Promise<boolean>;
  updateStatus(
    id: string,
    status: MessageTemplateStatus,
    rejectedReason?: string | null,
  ): Promise<MessageTemplate>;
  updateMetaTemplateId(
    id: string,
    metaTemplateId: string,
    status?: MessageTemplateStatus,
  ): Promise<MessageTemplate>;
}
