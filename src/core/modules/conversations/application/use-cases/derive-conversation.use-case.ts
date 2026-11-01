import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { CaseStatus } from "../../../cases/domain/case.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { EscalationService } from "../../../escalation/application/services/escalation.service";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";

const OPEN_CASE_STATUSES = new Set<CaseStatus>([
  "NEW",
  "ACTIVE",
  "WAITING_USER",
  "PAUSED",
  "ESCALATED",
  "HUMAN_ACTIVE",
]);

/**
 * Deriva una conversación que el asistente no convirtió en caso
 * (por ejemplo, un comprobante de pago que no identificó).
 * Abre un caso en el área elegida y lo deja en la cola de ese departamento.
 */
export class DeriveConversationUseCase {
  constructor(
    private readonly deps: {
      conversationRepo: ConversationRepositoryPort;
      caseRepo: CaseRepositoryPort;
      escalationService: EscalationService;
      departmentRepo: DepartmentRepositoryPort;
      agentRepo?: AgentRepositoryPort;
      messageRepo?: MessageRepositoryPort;
      broadcaster?: RealtimeBroadcaster;
      logger?: Logger;
    },
  ) {}

  async execute(input: {
    conversationId: string;
    agentUserId: string;
    toDepartmentId: string;
    reason?: string;
  }): Promise<{ caseId: string; departmentId: string; departmentName: string }> {
    const conversation = await this.deps.conversationRepo.findById(input.conversationId);
    if (!conversation) throw notFound(`Conversacion ${input.conversationId} no encontrada`);
    if (conversation.status === "resolved" || conversation.status === "closed") {
      throw businessError("La conversación ya está cerrada");
    }

    const cases = await this.deps.caseRepo.listByConversation(conversation.id);
    const openCase = cases.find((item) => OPEN_CASE_STATUSES.has(item.status));
    if (openCase) {
      throw businessError("Esta conversación ya tiene un caso. Transfiérelo desde el caso.");
    }

    const department = await this.deps.departmentRepo.findById(input.toDepartmentId);
    if (!department) throw notFound("Departamento no encontrado");

    const reason = input.reason?.trim() || "Caso real no identificado por el asistente";
    const created = await this.deps.escalationService.sendToTriage({
      conversationId: conversation.id,
      reason,
      correlationId: `manual-derive-${conversation.id}`,
      departmentId: department.id,
    });

    await this.deps.conversationRepo.setActiveCaseId(conversation.id, created.case.id);

    let actorName = "Agente";
    if (this.deps.agentRepo) {
      const actor = await this.deps.agentRepo.findById(input.agentUserId);
      if (actor?.name) actorName = actor.name;
    }

    if (this.deps.messageRepo) {
      const sysMessage = await this.deps.messageRepo.insertOutbound({
        conversationId: conversation.id,
        author: "system",
        body: `Caso derivado al área ${department.name} por ${actorName}. Motivo: ${reason}`,
        caseId: created.case.id,
        agentId: input.agentUserId,
        status: "sent",
      });
      this.deps.broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: conversation.id,
        messageId: sysMessage.id,
        author: "system",
      });
    }

    this.deps.logger?.info(
      { conversationId: conversation.id, caseId: created.case.id, departmentId: department.id },
      "conversación derivada manualmente",
    );

    return {
      caseId: created.case.id,
      departmentId: department.id,
      departmentName: department.name,
    };
  }
}
