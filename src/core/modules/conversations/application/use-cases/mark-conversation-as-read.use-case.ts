import { notFound } from "../../../../../shared/errors/domain-errors";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export class MarkConversationAsReadUseCase {
  constructor(
    private readonly conversationRepo: ConversationRepositoryPort,
    private readonly broadcaster?: RealtimeBroadcaster,
  ) {}

  async execute(conversationId: string): Promise<void> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw notFound("Conversacion no encontrada");
    }

    if (conversation.unreadCount > 0) {
      await this.conversationRepo.resetUnreadCount(conversationId);
      this.broadcaster?.publish({
        type: "MESSAGE_STATUS_UPDATED",
        conversationId,
        messageId: "read-marker",
        status: "read",
      });
    }
  }
}
