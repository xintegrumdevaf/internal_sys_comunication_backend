import type { Conversation, ConversationStatus } from "../../domain/conversation.entity";

export type ListConversationsFilter = {
  status?: ConversationStatus;
};

export interface ConversationRepositoryPort {
  findById(id: string): Promise<Conversation | null>;
  findByWaPhone(waPhone: string): Promise<Conversation | null>;
  /** Atomico solo si el llamador ya sostiene el lock de docs/spec 00 §3 (ver withConversationLock). */
  findOrCreateByWaPhone(waPhone: string): Promise<Conversation>;
  touchLastActivity(id: string): Promise<void>;
  list(filter: ListConversationsFilter): Promise<Conversation[]>;
}
