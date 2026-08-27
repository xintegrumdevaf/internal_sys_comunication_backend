import type { InternalMessage, InternalMessageType } from "../entities/internal-message.entity";

export interface CreateInternalMessageInput {
  threadId: string;
  senderAgentId: string;
  type?: InternalMessageType;
  body: string;
  contextData?: Record<string, unknown>;
}

export interface ListInternalMessagesOptions {
  limit?: number;
  cursor?: string; // ISO date string or message ID for pagination
}

export interface InternalMessageRepositoryPort {
  create(input: CreateInternalMessageInput): Promise<InternalMessage>;
  listByThread(
    threadId: string,
    options?: ListInternalMessagesOptions
  ): Promise<{ messages: InternalMessage[]; nextCursor: string | null }>;
}
