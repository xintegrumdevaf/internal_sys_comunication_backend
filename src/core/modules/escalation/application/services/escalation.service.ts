import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../../cases/domain/case.entity";
import { emptyContextFor } from "../../../cases/domain/contexts/case-context";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { WorkflowExecutionRepositoryPort } from "../../../cases/application/ports/workflow-execution.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { Escalation } from "../../domain/escalation.entity";
import type { EscalationRepositoryPort } from "../ports/escalation.repository.port";
import { CaseSummaryBuilderService } from "./case-summary-builder.service";
import { businessReplyForReason } from "./business-reply-catalog";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export type EscalationServiceDeps = {
  caseRepo: CaseRepositoryPort;
  escalationRepo: EscalationRepositoryPort;
  workflowExecutionRepo: WorkflowExecutionRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  summaryBuilder: CaseSummaryBuilderService;
  logger: Logger;
  broadcaster?: RealtimeBroadcaster;
};

/**
 * Política de errores → ESCALATED + automation off + fila escalation
 * (docs/spec/02_STATE_MACHINE.md §5 + §10, 03_API_CONTRACT.md §D).
 */
export class EscalationService {
  constructor(private readonly deps: EscalationServiceDeps) {}

  /**
   * Persiste la fila `escalation` + summary si aún no existe.
   * No cambia el status del caso (útil tras AdvanceCase que ya pasó a ESCALATED).
   */
  async ensureEscalationRecord(input: {
    caseId: string;
    reason: string;
    priority?: "low" | "normal" | "high" | "urgent";
  }): Promise<Escalation> {
    const existing = await this.deps.escalationRepo.findByCaseId(input.caseId);
    if (existing) return existing;

    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso ${input.caseId} no encontrado`);
    }

    await this.deps.caseRepo.setAutomationEnabled(aggregate.case.id, false, {
      reason: input.reason,
    });
    return this.persistEscalation(aggregate.case, input.reason, input.priority ?? "normal");
  }

  /**
   * Escala un caso existente (error técnico no recuperable / ESCALATED del motor).
   * Idempotente si ya existe fila `escalation` para el caseId.
   */
  async escalateExistingCase(input: {
    caseId: string;
    reason: string;
    priority?: "low" | "normal" | "high" | "urgent";
  }): Promise<{ case: Case; escalation: Escalation; customerMessage: string }> {
    const { caseRepo, escalationRepo, conversationRepo, logger } = this.deps;
    const aggregate = await caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso ${input.caseId} no encontrado`);
    }

    const existing = await escalationRepo.findByCaseId(input.caseId);
    if (existing) {
      return {
        case: aggregate.case,
        escalation: existing,
        customerMessage: businessReplyForReason(input.reason),
      };
    }

    let caseEntity = aggregate.case;
    if (caseEntity.status !== "ESCALATED" && caseEntity.status !== "HUMAN_ACTIVE") {
      const transitioned = await caseRepo.applyTransition({
        caseId: aggregate.case.id,
        expectedCaseVersion: aggregate.case.version,
        expectedWorkflowVersion: aggregate.workflowInstance.version,
        status: "ESCALATED",
        context: aggregate.case.context,
        currentState: aggregate.workflowInstance.currentState,
        expiresAt: null,
      });
      caseEntity = transitioned.case;
      await caseRepo.appendEvent(caseEntity.id, "CASE_ESCALATED", { reason: input.reason });
    }

    await caseRepo.setAutomationEnabled(caseEntity.id, false, { reason: input.reason });
    await conversationRepo.setActiveCaseId(caseEntity.conversationId, null);

    const escalation = await this.persistEscalation(caseEntity, input.reason, input.priority ?? "normal");
    const department = caseEntity.departmentId
      ? await this.deps.departmentRepo.findById(caseEntity.departmentId)
      : null;
    const customerMessage = businessReplyForReason(input.reason, department?.slug ?? null);

    logger.warn(
      { caseId: caseEntity.id, escalationId: escalation.id, reason: input.reason },
      "caso escalado con resumen estructurado",
    );
    this.deps.broadcaster?.publish({
      type: "CASE_ESCALATED",
      caseId: caseEntity.id,
      conversationId: caseEntity.conversationId,
      departmentId: caseEntity.departmentId,
      at: new Date().toISOString(),
    });
    return { case: caseEntity, escalation, customerMessage };
  }

  /**
   * Pool de triage: caso UNCLASSIFIED + department_id NULL + escalation sin dept
   * (02_STATE_MACHINE.md §10).
   */
  async sendToTriage(input: {
    conversationId: string;
    reason: string;
    correlationId: string;
  }): Promise<{ case: Case; escalation: Escalation; customerMessage: string }> {
    const { caseRepo, conversationRepo, logger } = this.deps;

    const aggregate = await caseRepo.create({
      conversationId: input.conversationId,
      workflowType: "UNCLASSIFIED",
      departmentId: null,
      context: emptyContextFor("UNCLASSIFIED"),
      initialState: "TRIAGE",
      expiresAt: null,
    });

    const transitioned = await caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "ESCALATED",
      context: aggregate.case.context,
      currentState: "TRIAGE",
      expiresAt: null,
    });

    await caseRepo.setAutomationEnabled(transitioned.case.id, false, { reason: input.reason });
    await caseRepo.appendEvent(transitioned.case.id, "CASE_ESCALATED", {
      reason: input.reason,
      triage: true,
      correlationId: input.correlationId,
    });
    await conversationRepo.setActiveCaseId(input.conversationId, null);

    const escalation = await this.persistEscalation(transitioned.case, input.reason, "normal");
    const customerMessage = businessReplyForReason("TRIAGE");

    logger.info(
      { caseId: transitioned.case.id, escalationId: escalation.id },
      "caso enviado al pool de triage",
    );
    this.deps.broadcaster?.publish({
      type: "CASE_ESCALATED",
      caseId: transitioned.case.id,
      conversationId: input.conversationId,
      departmentId: null,
      at: new Date().toISOString(),
    });
    return { case: transitioned.case, escalation, customerMessage };
  }

  customerMessageFor(reason: string, departmentSlug?: string | null): string {
    return businessReplyForReason(reason, departmentSlug);
  }

  private async persistEscalation(
    caseEntity: Case,
    reason: string,
    priority: "low" | "normal" | "high" | "urgent",
  ): Promise<Escalation> {
    const executions = await this.deps.workflowExecutionRepo.listByCase(caseEntity.id);
    const events = await this.deps.caseRepo.listEvents(caseEntity.id);
    const department = caseEntity.departmentId
      ? await this.deps.departmentRepo.findById(caseEntity.departmentId)
      : null;

    const summary = this.deps.summaryBuilder.build({
      caseEntity,
      reason,
      executions,
      events,
      departmentSlug: department?.slug ?? null,
    });

    return this.deps.escalationRepo.create({
      caseId: caseEntity.id,
      departmentId: caseEntity.departmentId,
      priority,
      reason,
      summary,
    });
  }
}
