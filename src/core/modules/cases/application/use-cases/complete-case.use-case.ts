import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case, CaseStatus } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import { assertCanWriteCase, resolveActingAgent } from "../../../escalation/application/use-cases/agent-case-auth";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { EnqueueQualityReviewService } from "../../../quality/application/services/enqueue-quality-review.service";

const COMPLETABLE: CaseStatus[] = ["ACTIVE", "WAITING_USER", "HUMAN_ACTIVE", "ESCALATED", "PAUSED"];
const ASSIGNMENT_GUARDED: CaseStatus[] = ["HUMAN_ACTIVE", "ESCALATED"];

export class CompleteCaseUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      conversationRepo: ConversationRepositoryPort;
      auditRepo: AuditRepositoryPort;
      logger: Logger;
      broadcaster?: RealtimeBroadcaster;
      /**
       * docs/spec/06_BACKEND_GAPS.md §2 — si el caso ya esta
       * HUMAN_ACTIVE/ESCALATED, solo el agente asignado (o manager/admin
       * con alcance) puede completarlo. Opcionales por compatibilidad.
       */
      agentRepo?: AgentRepositoryPort;
      departmentRepo?: DepartmentRepositoryPort;
      /** Etapa 10: encola analisis de calidad post-cierre (fire-and-forget). */
      enqueueQualityReview?: EnqueueQualityReviewService;
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

    if (ASSIGNMENT_GUARDED.includes(aggregate.case.status) && this.deps.agentRepo && this.deps.departmentRepo) {
      const agent = await resolveActingAgent(this.deps.agentRepo, input.agentUserId);
      await assertCanWriteCase({
        agent,
        caseEntity: aggregate.case,
        mode: "act",
        agentRepo: this.deps.agentRepo,
        departmentRepo: this.deps.departmentRepo,
      });
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
    await this.deps.conversationRepo.setStatus(aggregate.case.conversationId, "resolved");
    await this.deps.auditRepo.record({
      action: "CASE_COMPLETED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: input.agentUserId,
      metadata: { resolutionNote: input.resolutionNote ?? null },
    });
    this.deps.logger.info({ caseId: result.case.id }, "caso completado por agente");

    if (this.deps.enqueueQualityReview) {
      void this.deps.enqueueQualityReview.tryAutoEnqueue(result.case).catch((err) => {
        this.deps.logger.warn(
          { err, caseId: result.case.id },
          "no se pudo encolar review de calidad tras completar",
        );
      });
    }

    return result.case;
  }
}
