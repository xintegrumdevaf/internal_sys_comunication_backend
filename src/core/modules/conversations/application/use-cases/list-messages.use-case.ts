import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Message } from "../../domain/message.entity";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort, ListMessagesOptions } from "../ports/message.repository.port";

export class ListMessagesUseCase {
  constructor(
    private readonly conversationRepo: ConversationRepositoryPort,
    private readonly messageRepo: MessageRepositoryPort,
  ) {}

  async execute(conversationId: string, options: ListMessagesOptions = {}): Promise<Message[]> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw notFound(`Conversacion ${conversationId} no encontrada`);
    }
    return this.messageRepo.listByConversation(conversationId, options);
  }
}
