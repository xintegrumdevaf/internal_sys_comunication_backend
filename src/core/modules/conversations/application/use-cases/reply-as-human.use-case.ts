import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Message } from "../../domain/message.entity";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { WhatsAppSenderPort } from "../ports/whatsapp-sender.port";

export type ReplyAsHumanInput = {
  conversationId: string;
  agentUserId: string;
  body: string;
};

export type ReplyAsHumanDeps = {
  conversationRepo: ConversationRepositoryPort;
  messageRepo: MessageRepositoryPort;
  whatsappSender: WhatsAppSenderPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

/**
 * Respuesta humana (docs/spec/03_API_CONTRACT.md §C.2 `POST /api/conversations/:id/reply`).
 *
 * Desviacion documentada: el contrato indica que ademas debe forzar
 * `automation.enabled=false` si no lo estaba. `automation_state` pertenece
 * a `Case` (01_DATA_MODEL.md §2), que todavia no existe (nace en la Etapa 2).
 * Este caso de uso persiste y envia la respuesta; el toggle de automatizacion
 * se conecta cuando el modulo `cases` este disponible.
 */
export class ReplyAsHumanUseCase {
  constructor(private readonly deps: ReplyAsHumanDeps) {}

  async execute(input: ReplyAsHumanInput): Promise<Message> {
    const { conversationRepo, messageRepo, whatsappSender, auditRepo, logger } = this.deps;

    const conversation = await conversationRepo.findById(input.conversationId);
    if (!conversation) {
      throw notFound(`Conversacion ${input.conversationId} no encontrada`);
    }

    let externalId: string;
    try {
      ({ externalId } = await whatsappSender.sendText(conversation.waPhone, input.body));
    } catch (error) {
      logger.error(
        { err: error, conversationId: conversation.id, agentUserId: input.agentUserId },
        "fallo al enviar respuesta de agente por whatsapp",
      );
      throw error;
    }

    const message = await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "agent",
      body: input.body,
      externalId,
    });

    await conversationRepo.touchLastActivity(conversation.id);

    await auditRepo.record({
      action: "CONVERSATION_REPLY",
      resourceType: "conversation",
      resourceId: conversation.id,
      actorId: input.agentUserId,
      metadata: { messageId: message.id },
    });

    logger.info(
      { conversationId: conversation.id, messageId: message.id, agentUserId: input.agentUserId },
      "respuesta de agente enviada por whatsapp",
    );

    return message;
  }
}
