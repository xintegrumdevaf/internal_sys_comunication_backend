import type { Conversation, ConversationStatus } from "../../domain/conversation.entity";
import type { MessageAuthor } from "../../domain/message.entity";
import type { ConversationRepositoryPort, ListConversationsFilter } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";

export type ConversationDto = Conversation & {
  lastMessagePreview: {
    body: string;
    author: MessageAuthor;
    direction: "inbound" | "outbound";
    createdAt: Date;
  } | null;
};

export type ListConversationsQuery = ListConversationsFilter & {
  departmentId?: string;
  userId?: string;
};

/**
 * Lista conversaciones con `lastMessagePreview` (03_API_CONTRACT.md §C.4)
 * y filtros opcionales departmentId/userId vía casos asociados.
 */
export class ListConversationsUseCase {
  constructor(
    private readonly conversationRepo: ConversationRepositoryPort,
    private readonly messageRepo: MessageRepositoryPort,
    private readonly caseRepo?: CaseRepositoryPort,
  ) {}

  async execute(filter: ListConversationsQuery): Promise<ConversationDto[]> {
    let conversations = await this.conversationRepo.list({ status: filter.status });

    if ((filter.departmentId || filter.userId) && this.caseRepo) {
      const filtered: Conversation[] = [];
      for (const conv of conversations) {
        const cases = await this.caseRepo.listByConversation(conv.id);
        const match = cases.some((c) => {
          if (filter.departmentId && c.departmentId !== filter.departmentId) return false;
          if (filter.userId && c.assignedAgentId !== filter.userId) return false;
          return true;
        });
        if (match) filtered.push(conv);
      }
      conversations = filtered;
    }

    const lastMap = await this.messageRepo.findLastByConversationIds(conversations.map((c) => c.id));
    return conversations.map((c) => {
      const last = lastMap.get(c.id) ?? null;
      return {
        ...c,
        lastMessagePreview: last
          ? {
              body: last.body,
              author: last.author,
              direction: last.direction,
              createdAt: last.createdAt,
            }
          : null,
      };
    });
  }
}

export type { ConversationStatus };
