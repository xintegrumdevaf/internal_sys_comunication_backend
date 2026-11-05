import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case, CaseStatus } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import { assertCanWriteCase, resolveActingAgent } from "../../../escalation/application/use-cases/agent-case-auth";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { EnqueueQualityReviewService } from "../../../quality/application/services/enqueue-quality-review.service";
import type { DrainDepartmentQueueService } from "../../../escalation/application/services/drain-department-queue.service";

const COMPLETABLE: CaseStatus[] = ["ACTIVE", "WAITING_USER", "HUMAN_ACTIVE", "ESCALATED", "PAUSED"];
const ASSIGNMENT_GUARDED: CaseStatus[] = ["HUMAN_ACTIVE", "ESCALATED"];

export type CaseCloseReason = "RESOLVED" | "CLIENT_NO_RESPONSE";

export class CompleteCaseUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      conversationRepo: ConversationRepositoryPort;
      messageRepo?: MessageRepositoryPort;
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
      /** Despacho progresivo: drena el siguiente caso en cola tras liberar cupo. */
      drainQueue?: DrainDepartmentQueueService;
    },
  ) {}

  async execute(input: {
    caseId: string;
    agentUserId: string;
    resolutionNote?: string;
    closeReason?: CaseCloseReason;
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

    const closeReason = input.closeReason ?? "RESOLVED";

    const actor = this.deps.agentRepo
      ? await this.deps.agentRepo.findById(input.agentUserId)
      : null;
    const actorName = actor?.name || "Agente";
    const closedAt = new Date().toISOString();

    const result = await this.deps.caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "COMPLETED",
      context: {
        ...aggregate.case.context,
        closeReason,
        closedByAgentId: input.agentUserId,
        closedByAgentName: actorName,
        closedAt,
        resolutionNote: input.resolutionNote ?? null,
      },
      currentState: aggregate.workflowInstance.currentState,
      expiresAt: null,
    });
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_COMPLETED", {
      closeReason,
      resolutionNote: input.resolutionNote ?? null,
      agentUserId: input.agentUserId,
    });
    await this.deps.conversationRepo.setActiveCaseId(aggregate.case.conversationId, null);
    await this.deps.conversationRepo.setStatus(aggregate.case.conversationId, "resolved");

    // Registrar mensaje de sistema visible en la conversación para trazabilidad visual de todo el equipo
    if (this.deps.messageRepo) {
      const reasonLabel = closeReason === "CLIENT_NO_RESPONSE" ? "Cliente no respondió" : "Resuelto";
      const notePart = input.resolutionNote?.trim() ? ` • Nota: ${input.resolutionNote.trim()}` : "";
      const systemMessageText = `🔒 Caso completado por ${actorName} • Motivo: ${reasonLabel}${notePart}`;

      const sysMessage = await this.deps.messageRepo.insertOutbound({
        conversationId: aggregate.case.conversationId,
        author: "system",
        body: systemMessageText,
        caseId: aggregate.case.id,
        agentId: input.agentUserId,
        status: "sent",
      });

      this.deps.broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: aggregate.case.conversationId,
        messageId: sysMessage.id,
        author: "system",
      });
    }

    await this.deps.auditRepo.record({
      action: "CASE_COMPLETED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: input.agentUserId,
      metadata: { closeReason, resolutionNote: input.resolutionNote ?? null },
    });
    this.deps.logger.info({ caseId: result.case.id, closeReason }, "caso completado por agente");

    if (this.deps.enqueueQualityReview) {
      void this.deps.enqueueQualityReview.tryAutoEnqueue(result.case).catch((err) => {
        this.deps.logger.warn(
          { err, caseId: result.case.id },
          "no se pudo encolar review de calidad tras completar",
        );
      });
    }

    if (this.deps.drainQueue && aggregate.case.departmentId) {
      void this.deps.drainQueue.drainQueueForDepartment(aggregate.case.departmentId).catch((err) => {
        this.deps.logger.warn(
          { err, departmentId: aggregate.case.departmentId },
          "error al drenar cola del departamento tras completar caso",
        );
      });
    }

    return result.case;
  }
}
