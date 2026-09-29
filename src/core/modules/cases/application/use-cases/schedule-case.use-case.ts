import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case, CaseStatus } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

import type { CaseScheduleTag, CaseSchedulingMetadata } from "../../domain/contexts/case-context";

const SCHEDULABLE: CaseStatus[] = ["NEW", "ACTIVE", "WAITING_USER", "HUMAN_ACTIVE", "ESCALATED", "PAUSED"];

export class ScheduleCaseUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      conversationRepo?: ConversationRepositoryPort;
      auditRepo: AuditRepositoryPort;
      logger: Logger;
      broadcaster?: RealtimeBroadcaster;
    },
  ) {}

  async execute(input: {
    caseId: string;
    agentUserId: string;
    scheduledAt: Date;
    scheduleTag?: CaseScheduleTag | string;
  }): Promise<Case> {
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) throw notFound(`Caso ${input.caseId} no encontrado`);
    if (!SCHEDULABLE.includes(aggregate.case.status)) {
      throw businessError(`No se puede agendar un caso en estado ${aggregate.case.status}`);
    }

    if (isNaN(input.scheduledAt.getTime()) || input.scheduledAt.getTime() <= Date.now()) {
      throw businessError("La fecha de agendamiento debe ser una fecha futura válida");
    }

    const rawTag = (input.scheduleTag ?? "AGENDADO").toString().trim().toUpperCase();
    const scheduleTag: CaseScheduleTag = rawTag.length > 0 ? rawTag : "AGENDADO";

    const schedulingMetadata: CaseSchedulingMetadata = {
      scheduledAt: input.scheduledAt.toISOString(),
      scheduleTag,
      scheduledByAgentId: input.agentUserId,
      notifiedAt: null,
    };

    const updatedContext = {
      ...aggregate.case.context,
      schedulingMetadata,
    };

    const result = await this.deps.caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "WAITING_USER",
      context: updatedContext,
      currentState: aggregate.workflowInstance.currentState,
      expiresAt: input.scheduledAt,
    });

    if (this.deps.conversationRepo) {
      await this.deps.conversationRepo.setStatus(aggregate.case.conversationId, "pending");
    }

    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_SCHEDULED", {
      scheduledAt: input.scheduledAt.toISOString(),
      scheduleTag,
      agentUserId: input.agentUserId,
    });

    await this.deps.auditRepo.record({
      action: "CASE_SCHEDULED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: input.agentUserId,
      metadata: schedulingMetadata,
    });

    this.deps.logger.info(
      { caseId: result.case.id, scheduledAt: input.scheduledAt.toISOString() },
      "caso agendado exitosamente en sección En Espera",
    );

    return result.case;
  }
}
