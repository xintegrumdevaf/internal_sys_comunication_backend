import type Redis from "ioredis";
import { withConversationLock } from "../../../../../shared/queue/redis";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Conversation } from "../../domain/conversation.entity";
import type { Message } from "../../domain/message.entity";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { InboundBufferService } from "../../../ingestion/application/services/inbound-buffer.service";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export type ReceiveInboundMessageInput = {
  waPhone: string;
  externalId: string;
  body: string;
  type: string;
  mediaId?: string | null;
  mimeType?: string | null;
  caption?: string | null;
  filename?: string | null;
  /** `contacts[].profile.name` del webhook de Meta — ver conversation.entity.ts. */
  waProfileName?: string | null;
  /** correlationId de la request HTTP que origino el mensaje (trazabilidad, AGENTS.md). */
  correlationId?: string;
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
  logger: Logger;
  /** Opcional: si no se inyecta, el mensaje se persiste pero no se agrupa (tests de Etapa 1). */
  inboundBuffer?: InboundBufferService;
  broadcaster?: RealtimeBroadcaster;
};

/**
 * Ingesta de mensaje inbound (docs/spec/05_BUILD_PLAN.md Etapa 1).
 * Unico caso de uso que crea/reutiliza una Conversation y persiste el
 * mensaje crudo de forma idempotente, serializado por wa_phone via Redis.
 * Tras persistir, empuja el mensaje al buffer/debounce por conversacion
 * (docs/spec/02_STATE_MACHINE.md §12, Etapa 2) — nunca para un duplicado.
 */
export class ReceiveInboundMessageUseCase {
  constructor(private readonly deps: ReceiveInboundMessageDeps) {}

  async execute(input: ReceiveInboundMessageInput): Promise<ReceiveInboundMessageResult> {
    const { conversationRepo, messageRepo, redisClient, inboundBuffer, logger } = this.deps;
    const log = input.correlationId
      ? logger.child({ correlationId: input.correlationId })
      : logger;

    let conversation = await withConversationLock(redisClient, input.waPhone, () =>
      conversationRepo.findOrCreateByWaPhone(input.waPhone),
    );

    // Se actualiza en cada mensaje que lo traiga (la persona puede cambiar su
    // nombre de WhatsApp); nunca se pisa un nombre ya conocido con uno vacio.
    if (input.waProfileName && input.waProfileName !== conversation.waProfileName) {
      await conversationRepo.setWaProfileName(conversation.id, input.waProfileName);
      conversation = { ...conversation, waProfileName: input.waProfileName };
    }

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

    log.info(
      {
        conversationId: conversation.id,
        messageId: message.id,
        externalId: input.externalId,
        waPhone: input.waPhone,
        type: input.type,
        body: input.body,
        isDuplicate,
      },
      isDuplicate ? "mensaje inbound duplicado, se descarta" : "mensaje inbound recibido y persistido",
    );

    if (!isDuplicate) {
      await conversationRepo.touchLastActivity(conversation.id);
      await inboundBuffer?.push(conversation.id, message.id);
      this.deps.broadcaster?.publish({
        type: "MESSAGE_RECEIVED",
        conversationId: conversation.id,
        messageId: message.id,
        bodyPreview: input.body.substring(0, 100) || (input.type === "image" ? "📷 Imagen" : input.type === "audio" || input.type === "voice" ? "🎤 Audio" : "Mensaje nuevo"),
        authorName: input.waProfileName || conversation.waProfileName || conversation.waPhone,
      });
    }

    return { conversation, message, isDuplicate };
  }
}
