import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case, CaseStatus } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

const COMPLETABLE: CaseStatus[] = ["ACTIVE", "WAITING_USER", "HUMAN_ACTIVE", "ESCALATED", "PAUSED"];

export class CompleteCaseUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      conversationRepo: ConversationRepositoryPort;
      auditRepo: AuditRepositoryPort;
      logger: Logger;
      broadcaster?: RealtimeBroadcaster;
    },
  ) {}

  async execute(input: {
    caseId: string;
    agentUserId: string;
    resolutionNote?: string;
  }): Promise<Case> {
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) throw notFound(`Caso ${input.caseId} no encontrado`);
    if (!COMPLETABLE.includes(aggregate.case.status)) {
      throw businessError(`No se puede completar un caso en estado ${aggregate.case.status}`);
    }

    const result = await this.deps.caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "COMPLETED",
      context: aggregate.case.context,
      currentState: aggregate.workflowInstance.currentState,
      expiresAt: null,
    });
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_COMPLETED", {
      resolutionNote: input.resolutionNote ?? null,
      agentUserId: input.agentUserId,
    });
    await this.deps.conversationRepo.setActiveCaseId(aggregate.case.conversationId, null);
    await this.deps.auditRepo.record({
      action: "CASE_COMPLETED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: input.agentUserId,
      metadata: { resolutionNote: input.resolutionNote ?? null },
    });
    this.deps.logger.info({ caseId: result.case.id }, "caso completado por agente");
    return result.case;
  }
}
