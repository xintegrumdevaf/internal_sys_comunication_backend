import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../../cases/domain/case.entity";
import { emptyContextFor } from "../../../cases/domain/contexts/case-context";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { WorkflowExecutionRepositoryPort } from "../../../cases/application/ports/workflow-execution.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Escalation } from "../../domain/escalation.entity";
import type { EscalationRepositoryPort } from "../ports/escalation.repository.port";
import { CaseSummaryBuilderService } from "./case-summary-builder.service";
import { businessReplyForReason } from "./business-reply-catalog";
import type { AutoAssignAgentService } from "./auto-assign-agent.service";
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
  /**
   * docs/spec/06_BACKEND_GAPS.md §2 — si se provee, cada escalacion con
   * departamento resuelto (nunca el pool de triage) intenta auto-asignarse
   * a un agente humano disponible del departamento. Opcional para no
   * romper construcciones existentes de EscalationService en tests.
   */
  autoAssign?: AutoAssignAgentService;
  auditRepo?: AuditRepositoryPort;
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
    correlationId?: string;
  }): Promise<{ escalation: Escalation; caseEntity: Case }> {
    const log = this.deps.logger.child({
      correlationId: input.correlationId,
      caseId: input.caseId,
    });
    const existing = await this.deps.escalationRepo.findByCaseId(input.caseId);
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso ${input.caseId} no encontrado`);
    }
    if (existing) {
      return { escalation: existing, caseEntity: aggregate.case };
    }

    await this.deps.caseRepo.setAutomationEnabled(aggregate.case.id, false, {
      reason: input.reason,
    });
    const result = await this.persistEscalation(aggregate.case, input.reason, input.priority ?? "normal");
    log.info(
      { escalationId: result.escalation.id, reason: input.reason },
      "registro de escalacion persistido",
    );
    return result;
  }

  /**
   * Escala un caso existente (error técnico no recuperable / ESCALATED del motor).
   * Idempotente si ya existe fila `escalation` para el caseId.
   */
  async escalateExistingCase(input: {
    caseId: string;
    reason: string;
    priority?: "low" | "normal" | "high" | "urgent";
    correlationId?: string;
  }): Promise<{ case: Case; escalation: Escalation; customerMessage: string }> {
    const { caseRepo, escalationRepo, conversationRepo } = this.deps;
    const log = this.deps.logger.child({
      correlationId: input.correlationId,
      caseId: input.caseId,
    });
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

    const department = caseEntity.departmentId
      ? await this.deps.departmentRepo.findById(caseEntity.departmentId)
      : null;
    const customerMessage = businessReplyForReason(input.reason, department?.slug ?? null);

    // Se calcula el mensaje/evento ANTES del auto-assign (usa el status
    // ESCALATED "puro" para el catalogo de respuestas); el resultado que se
    // devuelve si usa el caso ya actualizado (puede quedar HUMAN_ACTIVE).
    this.deps.broadcaster?.publish({
      type: "CASE_ESCALATED",
      caseId: caseEntity.id,
      conversationId: caseEntity.conversationId,
      departmentId: caseEntity.departmentId,
      at: new Date().toISOString(),
    });

    const persisted = await this.persistEscalation(caseEntity, input.reason, input.priority ?? "normal");
    log.warn(
      { escalationId: persisted.escalation.id, reason: input.reason },
      "caso escalado con resumen estructurado",
    );
    return { case: persisted.caseEntity, escalation: persisted.escalation, customerMessage };
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
    const { caseRepo, conversationRepo } = this.deps;
    const log = this.deps.logger.child({
      correlationId: input.correlationId,
      conversationId: input.conversationId,
    });

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

    const { escalation, caseEntity } = await this.persistEscalation(transitioned.case, input.reason, "normal");
    const customerMessage = businessReplyForReason("TRIAGE");

    log.info(
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
    return { case: caseEntity, escalation, customerMessage };
  }

  customerMessageFor(reason: string, departmentSlug?: string | null): string {
    return businessReplyForReason(reason, departmentSlug);
  }

  private async persistEscalation(
    caseEntity: Case,
    reason: string,
    priority: "low" | "normal" | "high" | "urgent",
  ): Promise<{ escalation: Escalation; caseEntity: Case }> {
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

    const escalation = await this.deps.escalationRepo.create({
      caseId: caseEntity.id,
      departmentId: caseEntity.departmentId,
      priority,
      reason,
      summary,
    });

    if (department) {
      const autoAssigned = await this.tryAutoAssign(caseEntity, escalation, department.id);
      if (autoAssigned) return autoAssigned;
    }

    return { escalation, caseEntity };
  }

  /**
   * docs/spec/06_BACKEND_GAPS.md §2 — algoritmo de asignacion automatica.
   * Nunca se aplica al pool de triage (`department` es null ahi) — ese
   * sigue requiriendo clasificacion humana por manager/admin.
   */
  private async tryAutoAssign(
    caseEntity: Case,
    escalation: Escalation,
    departmentId: string,
  ): Promise<{ escalation: Escalation; caseEntity: Case } | null> {
    if (!this.deps.autoAssign) return null;
    const log = this.deps.logger.child({ caseId: caseEntity.id, departmentId });

    const agent = await this.deps.autoAssign.pickAgentForDepartment(departmentId);
    if (!agent) {
      log.info("sin agentes disponibles para auto-asignacion; queda pendiente en el pool");
      return null;
    }

    await this.deps.caseRepo.setAssignedAgent(caseEntity.id, agent.id);

    let updatedCase = caseEntity;
    if (caseEntity.status === "ESCALATED") {
      const aggregate = await this.deps.caseRepo.findById(caseEntity.id);
      if (aggregate) {
        const transitioned = await this.deps.caseRepo.applyTransition({
          caseId: caseEntity.id,
          expectedCaseVersion: aggregate.case.version,
          expectedWorkflowVersion: aggregate.workflowInstance.version,
          status: "HUMAN_ACTIVE",
          context: aggregate.case.context,
          currentState: aggregate.workflowInstance.currentState,
          expiresAt: aggregate.case.expiresAt,
        });
        updatedCase = transitioned.case;
      }
    } else {
      const fresh = await this.deps.caseRepo.findById(caseEntity.id);
      if (fresh) updatedCase = fresh.case;
    }

    const updatedEscalation = await this.deps.escalationRepo.updateAssignment(escalation.id, {
      assignedAgentId: agent.id,
      status: "ASSIGNED",
    });

    await this.deps.caseRepo.appendEvent(caseEntity.id, "HUMAN_ASSIGNED", {
      agentUserId: agent.id,
      via: "auto_assign",
    });
    await this.deps.auditRepo?.record({
      action: "CASE_AUTO_ASSIGNED",
      resourceType: "case",
      resourceId: caseEntity.id,
      actorId: null, // sistema, no un agente humano (docs/spec/06_BACKEND_GAPS.md §2)
      metadata: { assignedAgentId: agent.id, departmentId },
    });
    this.deps.broadcaster?.publish({
      type: "HUMAN_ASSIGNED",
      caseId: caseEntity.id,
      agentUserId: agent.id,
    });

    log.info({ agentId: agent.id }, "caso auto-asignado a agente humano");
    return { escalation: updatedEscalation, caseEntity: updatedCase };
  }
}
