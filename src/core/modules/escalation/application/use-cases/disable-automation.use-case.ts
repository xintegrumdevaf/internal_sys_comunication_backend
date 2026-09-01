import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { AutomationState } from "../../../cases/domain/automation-state.entity";
import type { CaseStatus } from "../../../cases/domain/case.entity";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import { assertCanWriteCase, resolveActingAgent } from "./agent-case-auth";

export type AutomationToggleDeps = {
  caseRepo: CaseRepositoryPort;
  agentRepo: AgentRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  conversationRepo?: ConversationRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

export class DisableAutomationUseCase {
  constructor(private readonly deps: AutomationToggleDeps) {}

  async execute(input: {
    caseId: string;
    agentUserId: string;
    reason: string;
  }): Promise<AutomationState> {
    const agent = await resolveActingAgent(this.deps.agentRepo, input.agentUserId);
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) throw notFound(`Caso ${input.caseId} no encontrado`);

    await assertCanWriteCase({
      agent,
      caseEntity: aggregate.case,
      mode: aggregate.case.assignedAgentId ? "act" : "claim",
      agentRepo: this.deps.agentRepo,
      departmentRepo: this.deps.departmentRepo,
    });

    const state = await this.deps.caseRepo.setAutomationEnabled(aggregate.case.id, false, {
      reason: input.reason,
      changedBy: agent.id,
    });
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "AUTOMATION_DISABLED", {
      reason: input.reason,
    });
    await this.deps.auditRepo.record({
      action: "AUTOMATION_DISABLED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: agent.id,
      metadata: { reason: input.reason },
    });
    this.deps.logger.info({ caseId: aggregate.case.id }, "automatizacion deshabilitada");
    return state;
  }
}

/**
 * Reactiva automation conservando context y sin reiniciar el workflow
 * (02_STATE_MACHINE.md §1 — automation independiente del estado).
 */
export class ReactivateAutomationUseCase {
  constructor(private readonly deps: AutomationToggleDeps) {}

  async execute(input: { caseId: string; agentUserId: string }): Promise<{
    automation: AutomationState;
    contextPreserved: true;
    currentState: string;
  }> {
    const agent = await resolveActingAgent(this.deps.agentRepo, input.agentUserId);
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) throw notFound(`Caso ${input.caseId} no encontrado`);

    await assertCanWriteCase({
      agent,
      caseEntity: aggregate.case,
      mode: aggregate.case.assignedAgentId ? "act" : "claim",
      agentRepo: this.deps.agentRepo,
      departmentRepo: this.deps.departmentRepo,
    });

    const contextBefore = structuredClone(aggregate.case.context);
    const stateBefore = aggregate.workflowInstance.currentState;

    const automation = await this.deps.caseRepo.setAutomationEnabled(aggregate.case.id, true, {
      reason: null,
      changedBy: agent.id,
    });

    // docs/spec/02_STATE_MACHINE.md §2: HUMAN_ACTIVE / ESCALATED -> ACTIVE (o WAITING_USER si espera respuesta).
    if (aggregate.case.status === "HUMAN_ACTIVE" || aggregate.case.status === "ESCALATED") {
      const fresh = await this.deps.caseRepo.findById(aggregate.case.id);
      if (fresh) {
        const targetStatus: CaseStatus = stateBefore.startsWith("WAITING_USER")
          ? "WAITING_USER"
          : "ACTIVE";

        await this.deps.caseRepo.applyTransition({
          caseId: aggregate.case.id,
          expectedCaseVersion: fresh.case.version,
          expectedWorkflowVersion: fresh.workflowInstance.version,
          status: targetStatus,
          context: fresh.case.context,
          currentState: stateBefore,
          expiresAt: null,
        });
      }
    }

    // Al devolver control a la IA, se libera la asignación del agente humano
    if (aggregate.case.assignedAgentId) {
      await this.deps.caseRepo.setAssignedAgent(aggregate.case.id, null);
    }

    const after = await this.deps.caseRepo.findById(aggregate.case.id);
    if (
      JSON.stringify(after?.case.context) !== JSON.stringify(contextBefore) ||
      after?.workflowInstance.currentState !== stateBefore
    ) {
      throw new Error("Invariant broken: reactivate-automation must not mutate context/state");
    }

    await this.deps.caseRepo.appendEvent(aggregate.case.id, "AUTOMATION_ENABLED", {});
    await this.deps.auditRepo.record({
      action: "AUTOMATION_ENABLED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: agent.id,
      metadata: {},
    });
    this.deps.logger.info(
      { caseId: aggregate.case.id, currentState: stateBefore },
      "automatizacion reactivada sin reiniciar workflow",
    );
    return {
      automation,
      contextPreserved: true,
      currentState: stateBefore,
    };
  }
}
