import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { EscalationRepositoryPort } from "../ports/escalation.repository.port";
import { assertCanWriteCase, resolveActingAgent } from "./agent-case-auth";

export type ClaimCaseDeps = {
  caseRepo: CaseRepositoryPort;
  escalationRepo: EscalationRepositoryPort;
  agentRepo: AgentRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

/**
 * Reclama un caso sin asignar (03_API_CONTRACT.md §C.2 claim + 02_STATE_MACHINE §11).
 */
export class ClaimCaseUseCase {
  constructor(private readonly deps: ClaimCaseDeps) {}

  async execute(input: { caseId: string; agentUserId: string }): Promise<void> {
    const agent = await resolveActingAgent(this.deps.agentRepo, input.agentUserId);
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso ${input.caseId} no encontrado`);
    }

    if (aggregate.case.assignedAgentId) {
      throw businessError("El caso ya tiene un agente asignado; usa reassign");
    }

    await assertCanWriteCase({
      agent,
      caseEntity: aggregate.case,
      mode: "claim",
      agentRepo: this.deps.agentRepo,
      departmentRepo: this.deps.departmentRepo,
    });

    await this.deps.caseRepo.setAssignedAgent(aggregate.case.id, agent.id);

    const targetDepartmentId = aggregate.case.departmentId ?? agent.primaryDepartmentId ?? null;

    if (aggregate.case.status === "ESCALATED" || (aggregate.case.departmentId === null && targetDepartmentId !== null)) {
      await this.deps.caseRepo.applyTransition({
        caseId: aggregate.case.id,
        expectedCaseVersion: aggregate.case.version,
        expectedWorkflowVersion: aggregate.workflowInstance.version,
        status: aggregate.case.status === "ESCALATED" ? "HUMAN_ACTIVE" : aggregate.case.status,
        context: aggregate.case.context,
        currentState: aggregate.workflowInstance.currentState,
        departmentId: targetDepartmentId,
        expiresAt: null,
      });
    }

    const escalation = await this.deps.escalationRepo.findByCaseId(aggregate.case.id);
    if (escalation) {
      await this.deps.escalationRepo.updateAssignment(escalation.id, {
        assignedAgentId: agent.id,
        status: "ASSIGNED",
        departmentId: targetDepartmentId,
      });
    }

    await this.deps.caseRepo.appendEvent(aggregate.case.id, "HUMAN_ASSIGNED", {
      agentUserId: agent.id,
      via: "claim",
    });
    await this.deps.auditRepo.record({
      action: "CASE_CLAIMED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: agent.id,
      metadata: {},
    });
    this.deps.logger.info({ caseId: aggregate.case.id, agentId: agent.id }, "caso reclamado");
  }
}
