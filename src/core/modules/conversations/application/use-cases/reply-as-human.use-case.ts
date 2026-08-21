import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import { assertCanWriteCase, resolveActingAgent } from "../../../escalation/application/use-cases/agent-case-auth";
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
  /** Etapa 6: deshabilita automation del caso activo al responder como humano. */
  caseRepo?: CaseRepositoryPort;
  /**
   * docs/spec/06_BACKEND_GAPS.md §2 — si el caso de la conversacion ya esta
   * `HUMAN_ACTIVE`/`ESCALATED`, solo el agente asignado (o manager/admin con
   * alcance) puede responder; el resto queda en solo lectura. Opcionales
   * para no romper construcciones existentes sin este chequeo.
   */
  agentRepo?: AgentRepositoryPort;
  departmentRepo?: DepartmentRepositoryPort;
};

/**
 * Respuesta humana (docs/spec/03_API_CONTRACT.md §C.2 `POST /api/conversations/:id/reply`).
 * Fuerza `automation.enabled=false` en el caso activo si no lo estaba.
 */
export class ReplyAsHumanUseCase {
  constructor(private readonly deps: ReplyAsHumanDeps) {}

  async execute(input: ReplyAsHumanInput): Promise<Message> {
    const { conversationRepo, messageRepo, whatsappSender, auditRepo, logger, caseRepo } = this.deps;

    const conversation = await conversationRepo.findById(input.conversationId);
    if (!conversation) {
      throw notFound(`Conversacion ${input.conversationId} no encontrada`);
    }

    if (caseRepo && this.deps.agentRepo && this.deps.departmentRepo) {
      const cases = await caseRepo.listByConversation(conversation.id);
      const humanCase = cases.find((c) => c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED");
      if (humanCase) {
        const agent = await resolveActingAgent(this.deps.agentRepo, input.agentUserId);
        await assertCanWriteCase({
          agent,
          caseEntity: humanCase,
          mode: "act",
          agentRepo: this.deps.agentRepo,
          departmentRepo: this.deps.departmentRepo,
        });
      }
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

    let effectiveCaseId = conversation.activeCaseId;
    if (!effectiveCaseId && caseRepo) {
      const cases = await caseRepo.listByConversation(conversation.id);
      const active =
        cases.find((c) => c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED") ??
        cases.find((c) => c.status === "ACTIVE" || c.status === "WAITING_USER") ??
        cases[cases.length - 1];
      if (active) effectiveCaseId = active.id;
    }

    const message = await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "agent",
      body: input.body,
      externalId,
      agentId: input.agentUserId,
      caseId: effectiveCaseId,
    });

    await conversationRepo.touchLastActivity(conversation.id);

    if (caseRepo && effectiveCaseId) {
      const automation = await caseRepo.getAutomationState(effectiveCaseId);
      if (automation?.enabled) {
        await caseRepo.setAutomationEnabled(effectiveCaseId, false, {
          reason: "HUMAN_REPLY",
          changedBy: input.agentUserId,
        });
        await caseRepo.appendEvent(effectiveCaseId, "AUTOMATION_DISABLED", {
          reason: "HUMAN_REPLY",
        });
      }
    }

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
