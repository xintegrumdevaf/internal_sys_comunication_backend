import { randomUUID } from "node:crypto";
import type { Conversation, ConversationStatus } from "../../src/core/modules/conversations/domain/conversation.entity";
import type {
  ConversationRepositoryPort,
  ListConversationsFilter,
} from "../../src/core/modules/conversations/application/ports/conversation.repository.port";
import type { Message } from "../../src/core/modules/conversations/domain/message.entity";
import type {
  InsertInboundMessageInput,
  InsertOutboundMessageInput,
  MessageRepositoryPort,
} from "../../src/core/modules/conversations/application/ports/message.repository.port";
import type { WhatsAppSenderPort } from "../../src/core/modules/conversations/application/ports/whatsapp-sender.port";
import type { Department } from "../../src/core/modules/departments/domain/department.entity";
import type {
  CreateDepartmentInput,
  UpdateDepartmentInput,
  DepartmentRepositoryPort,
} from "../../src/core/modules/departments/application/ports/department.repository.port";

/**
 * Fakes en memoria (docs/skills/testing-strategy.md).
 */
export class ConversationRepositoryFake implements ConversationRepositoryPort {
  readonly conversations = new Map<string, Conversation>();

  seed(conversation: Conversation): Conversation {
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  createOpen(overrides: Partial<Conversation> = {}): Conversation {
    const now = new Date();
    const conversation: Conversation = {
      id: randomUUID(),
      waPhone: `+59399${randomUUID().slice(0, 7)}`,
      customerId: null,
      activeCaseId: null,
      status: "open",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
      waProfileName: null,
      unreadCount: 0,
      ...overrides,
    };
    return this.seed(conversation);
  }

  async findById(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async findByWaPhone(waPhone: string): Promise<Conversation | null> {
    return [...this.conversations.values()].find((c) => c.waPhone === waPhone) ?? null;
  }

  async findOrCreateByWaPhone(waPhone: string): Promise<Conversation> {
    const existing = await this.findByWaPhone(waPhone);
    return existing ?? this.createOpen({ waPhone });
  }

  async touchLastActivity(id: string): Promise<void> {
    const conversation = this.conversations.get(id);
    if (conversation) {
      this.conversations.set(id, { ...conversation, lastActivityAt: new Date() });
    }
  }

  async incrementUnreadCount(id: string): Promise<void> {
    const conversation = this.conversations.get(id);
    if (conversation) {
      this.conversations.set(id, { ...conversation, unreadCount: conversation.unreadCount + 1 });
    }
  }

  async resetUnreadCount(id: string): Promise<void> {
    const conversation = this.conversations.get(id);
    if (conversation) {
      this.conversations.set(id, { ...conversation, unreadCount: 0 });
    }
  }

  async list(_filter: ListConversationsFilter): Promise<Conversation[]> {
    return [...this.conversations.values()];
  }

  async setActiveCaseId(id: string, caseId: string | null): Promise<void> {
    const conversation = this.conversations.get(id);
    if (conversation) {
      this.conversations.set(id, { ...conversation, activeCaseId: caseId });
    }
  }

  async setCustomerId(id: string, customerId: string | null): Promise<void> {
    const conversation = this.conversations.get(id);
    if (conversation) {
      this.conversations.set(id, { ...conversation, customerId });
    }
  }

  async setWaProfileName(id: string, name: string): Promise<void> {
    const conversation = this.conversations.get(id);
    if (conversation) {
      this.conversations.set(id, { ...conversation, waProfileName: name });
    }
  }

  async setStatus(id: string, status: ConversationStatus): Promise<void> {
    const conversation = this.conversations.get(id);
    if (conversation) {
      this.conversations.set(id, { ...conversation, status });
    }
  }
}

export class MessageRepositoryFake implements MessageRepositoryPort {
  readonly messages: Message[] = [];

  seedText(conversationId: string, body: string, overrides: Partial<Message> = {}): Message {
    const message: Message = {
      id: randomUUID(),
      conversationId,
      caseId: null,
      direction: "inbound",
      author: "customer",
      agentId: null,
      externalId: randomUUID(),
      body,
      type: "text",
      mediaId: null,
      mimeType: null,
      caption: null,
      filename: null,
      createdAt: new Date(),
      ...overrides,
    };
    this.messages.push(message);
    return message;
  }

  async insertInbound(input: InsertInboundMessageInput): Promise<{ message: Message; isDuplicate: boolean }> {
    const existing = this.messages.find(
      (m) => m.conversationId === input.conversationId && m.externalId === input.externalId,
    );
    if (existing) return { message: existing, isDuplicate: true };
    const message = this.seedText(input.conversationId, input.body, {
      externalId: input.externalId,
      type: input.type,
      mediaId: input.mediaId ?? null,
      mimeType: input.mimeType ?? null,
      caption: input.caption ?? null,
      filename: input.filename ?? null,
    });
    return { message, isDuplicate: false };
  }

  async insertOutbound(input: InsertOutboundMessageInput): Promise<Message> {
    const message: Message = {
      id: randomUUID(),
      conversationId: input.conversationId,
      caseId: input.caseId ?? null,
      direction: "outbound",
      author: input.author,
      agentId: input.agentId ?? null,
      externalId: input.externalId ?? null,
      body: input.body,
      type: "text",
      mediaId: null,
      mimeType: null,
      caption: null,
      filename: null,
      createdAt: new Date(),
    };
    this.messages.push(message);
    return message;
  }

  async listByCaseAuthors(
    caseId: string,
    authors: Array<"customer" | "agent">,
  ): Promise<Message[]> {
    const set = new Set(authors);
    return this.messages
      .filter((m) => m.caseId === caseId && set.has(m.author as "customer" | "agent"))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async listByConversation(
    conversationId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Message[]> {
    let list = this.messages
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (options.cursor) {
      const cursorTs = new Date(options.cursor).getTime();
      list = list.filter((m) => m.createdAt.getTime() < cursorTs);
    }
    if (options.limit && options.limit > 0) {
      list = list.slice(-options.limit);
    }
    return list;
  }

  async findByIds(ids: string[]): Promise<Message[]> {
    const set = new Set(ids);
    return this.messages.filter((m) => set.has(m.id));
  }

  async findLastByConversationIds(conversationIds: string[]): Promise<Map<string, Message>> {
    const set = new Set(conversationIds);
    const map = new Map<string, Message>();
    for (const message of this.messages) {
      if (!set.has(message.conversationId)) continue;
      const prev = map.get(message.conversationId);
      if (!prev || message.createdAt > prev.createdAt) {
        map.set(message.conversationId, message);
      }
    }
    return map;
  }
}

export class WhatsAppSenderFake implements WhatsAppSenderPort {
  readonly sent: Array<{ waPhone: string; body: string }> = [];

  async sendText(waPhone: string, body: string): Promise<{ externalId: string }> {
    this.sent.push({ waPhone, body });
    return { externalId: `wamid.${randomUUID()}` };
  }
}

export class DepartmentRepositoryFake implements DepartmentRepositoryPort {
  readonly departments = new Map<string, Department>();

  seed(department: Partial<Department> & { slug: string; name: string }): Department {
    const now = new Date();
    const full: Department = {
      id: department.id ?? randomUUID(),
      slug: department.slug,
      name: department.name,
      visibility: department.visibility ?? "shared",
      active: department.active ?? true,
      createdAt: department.createdAt ?? now,
    };
    this.departments.set(full.id, full);
    return full;
  }

  async list(): Promise<Department[]> {
    return [...this.departments.values()];
  }

  async findBySlug(slug: string): Promise<Department | null> {
    return [...this.departments.values()].find((d) => d.slug === slug) ?? null;
  }

  async findById(id: string): Promise<Department | null> {
    return this.departments.get(id) ?? null;
  }

  async create(input: CreateDepartmentInput): Promise<Department> {
    return this.seed(input);
  }

  async update(id: string, input: UpdateDepartmentInput): Promise<Department> {
    const department = this.departments.get(id);
    if (!department) throw new Error("Not found");
    const updated = { ...department, ...input } as Department;
    this.departments.set(id, updated);
    return updated;
  }

  async deactivate(id: string): Promise<Department> {
    const department = this.departments.get(id);
    if (!department) throw new Error("Not found");
    const updated = { ...department, active: false };
    this.departments.set(id, updated);
    return updated;
  }

  async hasActiveAgents(_id: string): Promise<boolean> {
    return false;
  }

  async hasOpenCases(_id: string): Promise<boolean> {
    return false;
  }
}
