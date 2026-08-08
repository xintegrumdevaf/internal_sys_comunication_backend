import type Redis from "ioredis";
import { withConversationLock } from "../../../../../shared/queue/redis";
import type { Conversation } from "../../domain/conversation.entity";
import type { Message } from "../../domain/message.entity";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";

export type ReceiveInboundMessageInput = {
  waPhone: string;
  externalId: string;
  body: string;
  type: string;
  mediaId?: string | null;
  mimeType?: string | null;
  caption?: string | null;
  filename?: string | null;
};

export type ReceiveInboundMessageResult = {
  conversation: Conversation;
  message: Message;
  isDuplicate: boolean;
};

export type ReceiveInboundMessageDeps = {
  conversationRepo: ConversationRepositoryPort;
  messageRepo: MessageRepositoryPort;
  redisClient: Redis;
};

/**
 * Ingesta de mensaje inbound (docs/spec/05_BUILD_PLAN.md Etapa 1).
 * Unico caso de uso que crea/reutiliza una Conversation y persiste el
 * mensaje crudo de forma idempotente, serializado por wa_phone via Redis.
 */
export class ReceiveInboundMessageUseCase {
  constructor(private readonly deps: ReceiveInboundMessageDeps) {}

  async execute(input: ReceiveInboundMessageInput): Promise<ReceiveInboundMessageResult> {
    const { conversationRepo, messageRepo, redisClient } = this.deps;

    const conversation = await withConversationLock(redisClient, input.waPhone, () =>
      conversationRepo.findOrCreateByWaPhone(input.waPhone),
    );

    const { message, isDuplicate } = await messageRepo.insertInbound({
      conversationId: conversation.id,
      externalId: input.externalId,
      body: input.body,
      type: input.type,
      mediaId: input.mediaId ?? null,
      mimeType: input.mimeType ?? null,
      caption: input.caption ?? null,
      filename: input.filename ?? null,
    });

    if (!isDuplicate) {
      await conversationRepo.touchLastActivity(conversation.id);
    }

    return { conversation, message, isDuplicate };
  }
}
