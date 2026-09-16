import type Redis from "ioredis";
import { withConversationLock } from "../../../../../shared/queue/redis";
import type { Logger } from "../../../../../shared/logging/logger";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { InboundBufferService } from "../../../ingestion/application/services/inbound-buffer.service";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";

export type ReceiveInboundEditInput = {
  waPhone: string;
  originalExternalId: string;
  newExternalId: string;
  newBody: string;
  correlationId?: string;
};

export type ReceiveInboundEditResult = {
  updated: boolean;
  messageId: string | null;
  conversationId: string | null;
  wasBuffered: boolean;
};

export type ReceiveInboundEditDeps = {
  conversationRepo: ConversationRepositoryPort;
  messageRepo: MessageRepositoryPort;
  redisClient: Redis;
  logger: Logger;
  inboundBuffer?: InboundBufferService;
  broadcaster?: RealtimeBroadcaster;
  caseRepo?: CaseRepositoryPort;
};

/**
 * Procesa la edición de un mensaje por parte del cliente en WhatsApp (type === "edit").
 * 1. Actualiza el body del mensaje en Postgres manteniendo edit_history y edited_at.
 * 2. Si el mensaje está aún en el buffer de debounce, resetea el timer para que la IA
 *    procese directamente el texto corregido sin duplicar trabajo.
 * 3. Si la edición es posterior al debounce y hay un caso activo con la IA, re-encola
 *    el mensaje para que el bot responda confirmando la corrección y avanzando el flujo.
 * 4. Notifica en tiempo real al frontend (MESSAGE_EDITED).
 */
export class ReceiveInboundEditUseCase {
  constructor(private readonly deps: ReceiveInboundEditDeps) {}

  async execute(input: ReceiveInboundEditInput): Promise<ReceiveInboundEditResult> {
    const { conversationRepo, messageRepo, redisClient, inboundBuffer, broadcaster, caseRepo, logger } = this.deps;
    const log = input.correlationId
      ? logger.child({ correlationId: input.correlationId })
      : logger;

    return withConversationLock(redisClient, input.waPhone, async () => {
      const conversation = await conversationRepo.findByWaPhone(input.waPhone);
      if (!conversation) {
        log.warn(
          { waPhone: input.waPhone, originalExternalId: input.originalExternalId },
          "edicion descartada: conversacion no encontrada",
        );
        return { updated: false, messageId: null, conversationId: null, wasBuffered: false };
      }

      const { updated, message } = await messageRepo.updateMessageBodyByExternalId(
        input.originalExternalId,
        input.newBody,
      );

      if (!updated || !message) {
        log.warn(
          { originalExternalId: input.originalExternalId, conversationId: conversation.id },
          "edicion descartada: mensaje original no encontrado en base de datos",
        );
        return { updated: false, messageId: null, conversationId: conversation.id, wasBuffered: false };
      }

      log.info(
        {
          conversationId: conversation.id,
          messageId: message.id,
          originalExternalId: input.originalExternalId,
          newBody: input.newBody,
        },
        "mensaje editado por cliente actualizado en base de datos",
      );

      // 1. Verificar si estaba dentro de la ventana de debounce (pre-flush)
      const wasBuffered = inboundBuffer?.touch(conversation.id) ?? false;

      // 2. Si la edición es tardía (post-flush) y hay un caso activo en espera de respuesta
      if (!wasBuffered && caseRepo && inboundBuffer) {
        const activeCase = await caseRepo.findActiveByConversation(conversation.id);
        if (activeCase && (activeCase.case.status === "WAITING_USER" || activeCase.case.status === "ACTIVE")) {
          log.info(
            { conversationId: conversation.id, caseId: activeCase.case.id },
            "edicion tardia con caso activo: re-encolando en buffer para que la IA responda y procese correccion",
          );
          await inboundBuffer.push(conversation.id, message.id);
        }
      }

      // 3. Notificar en tiempo real al frontend
      broadcaster?.publish({
        type: "MESSAGE_EDITED",
        conversationId: conversation.id,
        messageId: message.id,
        newBody: input.newBody,
        editedAt: (message.editedAt ?? new Date()).toISOString(),
      });

      return {
        updated: true,
        messageId: message.id,
        conversationId: conversation.id,
        wasBuffered,
      };
    });
  }
}
