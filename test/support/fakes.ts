import { randomUUID } from "node:crypto";
import type { Conversation } from "../../src/core/modules/conversations/domain/conversation.entity";
import type {
  ConversationRepositoryPort,
  ListConversationsFilter,
} from "../../src/core/modules/conversations/application/ports/conversation.repository.port";
import type { Department } from "../../src/core/modules/departments/domain/department.entity";
import type {
  CreateDepartmentInput,
  DepartmentRepositoryPort,
} from "../../src/core/modules/departments/application/ports/department.repository.port";

/**
 * Fakes en memoria (docs/skills/testing-strategy.md: "preferir una
 * implementacion en memoria completa de un puerto sobre mockear metodo por
 * metodo"). Reutilizados por los tests de `cases`/`ingestion` que no
 * necesitan tocar Postgres real.
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

  async list(_filter: ListConversationsFilter): Promise<Conversation[]> {
    return [...this.conversations.values()];
  }

  async setActiveCaseId(id: string, caseId: string | null): Promise<void> {
    const conversation = this.conversations.get(id);
    if (conversation) {
      this.conversations.set(id, { ...conversation, activeCaseId: caseId });
    }
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
}
