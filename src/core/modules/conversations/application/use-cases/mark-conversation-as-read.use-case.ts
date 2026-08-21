import { notFound } from "../../../../../shared/errors/domain-errors";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";

export class MarkConversationAsReadUseCase {
  constructor(private readonly conversationRepo: ConversationRepositoryPort) {}

  async execute(conversationId: string): Promise<void> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw notFound("Conversacion no encontrada");
    }

    if (conversation.unreadCount > 0) {
      await this.conversationRepo.resetUnreadCount(conversationId);
    }
  }
}
