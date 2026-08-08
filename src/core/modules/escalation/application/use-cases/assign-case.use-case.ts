import {
  authorizationError,
  notFound,
  validationError,
} from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { EscalationRepositoryPort } from "../ports/escalation.repository.port";
import { resolveActingAgent } from "./agent-case-auth";

export type AssignCaseDeps = {
  caseRepo: CaseRepositoryPort;
  escalationRepo: EscalationRepositoryPort;
  agentRepo: AgentRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

/**
 * Asigna/reasigna (manager/admin). En triage puede fijar `departmentId`
 * (03_API_CONTRACT.md §C.2 + 02_STATE_MACHINE.md §10).
 */
export class AssignCaseUseCase {
  constructor(private readonly deps: AssignCaseDeps) {}

  async execute(input: {
    caseId: string;
    actorAgentId: string;
    agentUserId: string;
    departmentId?: string | null;
    reassign?: boolean;
  }): Promise<void> {
    const actor = await resolveActingAgent(this.deps.agentRepo, input.actorAgentId);
    if (actor.role !== "manager" && actor.role !== "admin") {
      throw authorizationError("Solo manager o admin pueden assign/reassign");
    }

    const target = await resolveActingAgent(this.deps.agentRepo, input.agentUserId);
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso ${input.caseId} no encontrado`);
    }

    if (input.reassign && !aggregate.case.assignedAgentId) {
      throw validationError("El caso no está asignado; usa claim o assign");
    }

    const isTriage = aggregate.case.departmentId === null;

    if (!isTriage && actor.role === "manager") {
      const belongs = await this.deps.agentRepo.belongsToDepartment(
        actor.id,
        aggregate.case.departmentId!,
      );
      const primary = actor.primaryDepartmentId === aggregate.case.departmentId;
      if (!belongs && !primary) {
        throw authorizationError("Manager sin alcance sobre el departamento del caso");
      }
    }

    let departmentId = aggregate.case.departmentId;
    if (input.departmentId !== undefined) {
      if (!isTriage && actor.role !== "admin") {
        throw authorizationError(
          "Solo se reclasifica departamento desde el pool de triage o como admin",
        );
      }
      departmentId = input.departmentId;
      if (departmentId) {
        const dept = await this.deps.departmentRepo.findById(departmentId);
        if (!dept) throw notFound(`Departamento ${departmentId} no encontrado`);
      }
    }

    const nextStatus =
      aggregate.case.status === "ESCALATED" ? "HUMAN_ACTIVE" : aggregate.case.status;

    if (
      departmentId !== aggregate.case.departmentId ||
      nextStatus !== aggregate.case.status
    ) {
      await this.deps.caseRepo.applyTransition({
        caseId: aggregate.case.id,
        expectedCaseVersion: aggregate.case.version,
        expectedWorkflowVersion: aggregate.workflowInstance.version,
        status: nextStatus,
        context: aggregate.case.context,
        currentState: aggregate.workflowInstance.currentState,
        departmentId,
        expiresAt: aggregate.case.expiresAt,
      });
    }

    await this.deps.caseRepo.setAssignedAgent(aggregate.case.id, target.id);

    const escalation = await this.deps.escalationRepo.findByCaseId(aggregate.case.id);
    if (escalation) {
      await this.deps.escalationRepo.updateAssignment(escalation.id, {
        assignedAgentId: target.id,
        status: "ASSIGNED",
        departmentId,
      });
    }

    await this.deps.caseRepo.appendEvent(aggregate.case.id, "HUMAN_ASSIGNED", {
      agentUserId: target.id,
      via: input.reassign ? "reassign" : "assign",
      departmentId,
    });
    await this.deps.auditRepo.record({
      action: input.reassign ? "CASE_REASSIGNED" : "CASE_ASSIGNED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: actor.id,
      metadata: { assignedAgentId: target.id, departmentId },
    });
    this.deps.logger.info(
      { caseId: aggregate.case.id, assignedAgentId: target.id, actorId: actor.id },
      "caso asignado",
    );
  }
}
