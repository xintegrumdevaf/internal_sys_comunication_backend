import type { Conversation } from "../../domain/conversation.entity";
import type { ConversationRepositoryPort, ListConversationsFilter } from "../ports/conversation.repository.port";

export class ListConversationsUseCase {
  constructor(private readonly conversationRepo: ConversationRepositoryPort) {}

  async execute(filter: ListConversationsFilter): Promise<Conversation[]> {
    return this.conversationRepo.list(filter);
  }
}
