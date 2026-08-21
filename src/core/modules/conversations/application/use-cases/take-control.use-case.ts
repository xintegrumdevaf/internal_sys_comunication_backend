import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { ClaimCaseUseCase } from "../../../escalation/application/use-cases/claim-case.use-case";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

/**
 * Un agente toma control de la conversación (03_API_CONTRACT.md §C.2 take-control):
 * reclama el caso activo (o el más reciente no terminal) y deshabilita automation.
 */
export class TakeControlUseCase {
  constructor(
    private readonly deps: {
      conversationRepo: ConversationRepositoryPort;
      caseRepo: CaseRepositoryPort;
      claimCase: ClaimCaseUseCase;
      logger: Logger;
      broadcaster?: RealtimeBroadcaster;
    },
  ) {}

  async execute(input: {
    conversationId: string;
    agentUserId: string;
  }): Promise<{
    caseId: string;
    status: string;
    automationEnabled: boolean;
    assignedAgentId: string;
  }> {
    const conversation = await this.deps.conversationRepo.findById(input.conversationId);
    if (!conversation) throw notFound(`Conversacion ${input.conversationId} no encontrada`);

    let caseId = conversation.activeCaseId;
    if (!caseId) {
      const cases = await this.deps.caseRepo.listByConversation(conversation.id);
      const candidate = cases.find(
        (c) => c.status === "ESCALATED" || c.status === "HUMAN_ACTIVE" || c.status === "WAITING_USER",
      );
      if (!candidate) {
        throw businessError("No hay caso activo o reclamable en esta conversación");
      }
      caseId = candidate.id;
    }

    const aggregate = await this.deps.caseRepo.findById(caseId);
    if (!aggregate) throw notFound(`Caso ${caseId} no encontrado`);

    if (!aggregate.case.assignedAgentId) {
      await this.deps.claimCase.execute({ caseId, agentUserId: input.agentUserId });
    } else if (aggregate.case.assignedAgentId !== input.agentUserId) {
      throw businessError("La conversación ya está bajo control de otro agente");
    }

    const currentFresh = await this.deps.caseRepo.findById(caseId);
    if (currentFresh && currentFresh.case.status !== "HUMAN_ACTIVE" && currentFresh.case.status !== "COMPLETED" && currentFresh.case.status !== "CANCELLED") {
      await this.deps.caseRepo.applyTransition({
        caseId,
        expectedCaseVersion: currentFresh.case.version,
        expectedWorkflowVersion: currentFresh.workflowInstance.version,
        status: "HUMAN_ACTIVE",
        context: currentFresh.case.context,
        currentState: currentFresh.workflowInstance.currentState,
        expiresAt: null,
      });
    }

    await this.deps.caseRepo.setAutomationEnabled(caseId, false, {
      reason: "TAKE_CONTROL",
      changedBy: input.agentUserId,
    });
    await this.deps.caseRepo.appendEvent(caseId, "AUTOMATION_DISABLED", { reason: "TAKE_CONTROL" });
    await this.deps.conversationRepo.setActiveCaseId(conversation.id, caseId);

    this.deps.broadcaster?.publish({
      type: "CASE_CLAIMED",
      caseId,
      agentUserId: input.agentUserId,
    });
    this.deps.broadcaster?.publish({
      type: "AUTOMATION_DISABLED",
      caseId,
    });

    this.deps.logger.info(
      { conversationId: conversation.id, caseId, agentUserId: input.agentUserId },
      "agente tomo control de la conversacion",
    );
    return {
      caseId,
      status: "HUMAN_ACTIVE",
      automationEnabled: false,
      assignedAgentId: input.agentUserId,
    };
  }
}
