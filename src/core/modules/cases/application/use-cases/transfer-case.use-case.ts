import { notFound, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { AutoAssignAgentService } from "../../../escalation/application/services/auto-assign-agent.service";
import type { EscalationRepositoryPort } from "../../../escalation/application/ports/escalation.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";

export type TransferCaseDeps = {
  caseRepo: CaseRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
  autoAssign?: AutoAssignAgentService;
  escalationRepo?: EscalationRepositoryPort;
  broadcaster?: RealtimeBroadcaster;
  messageRepo?: MessageRepositoryPort;
  agentRepo?: AgentRepositoryPort;
};

/**
 * Transferencia de departamento / agente (03_API_CONTRACT.md §C.2), auditada.
 * Conserva context y currentState; no reinicia el workflow.
 * Auto-asigna automáticamente a un agente elegible del nuevo departamento si está disponible
 * o asigna directamente al agente indicado en toAgentId.
 * Deja un respaldo visible en la conversación mediante un mensaje del sistema.
 */
export class TransferCaseUseCase {
  constructor(private readonly deps: TransferCaseDeps) {}

  async execute(input: {
    caseId: string;
    toDepartmentId?: string;
    toAgentId?: string;
    reason: string;
    agentUserId: string;
  }): Promise<Case> {
    const reason = input.reason?.trim() ? input.reason.trim() : "Transferencia de caso";
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) throw notFound(`Caso ${input.caseId} no encontrado`);

    if (!input.toDepartmentId && !input.toAgentId) {
      throw validationError("Debe especificar departamento o agente destino para transferir");
    }

    let assignedAgent: import("../../../departments/domain/agent.entity").Agent | null = null;
    let targetDeptId = input.toDepartmentId ?? aggregate.case.departmentId;

    if (input.toAgentId && this.deps.agentRepo) {
      assignedAgent = await this.deps.agentRepo.findById(input.toAgentId);
      if (!assignedAgent || !assignedAgent.active) {
        throw notFound(`Agente destino ${input.toAgentId} no encontrado o inactivo`);
      }
      if (!input.toDepartmentId && assignedAgent.primaryDepartmentId) {
        targetDeptId = assignedAgent.primaryDepartmentId;
      }
    } else if (targetDeptId && this.deps.autoAssign) {
      // Intentar auto-asignar a un agente elegible del nuevo departamento
      assignedAgent = await this.deps.autoAssign.pickAgentForDepartment(targetDeptId, {
        fallbackToAnyActive: true,
      });
    }

    let dept = null;
    if (targetDeptId) {
      dept = await this.deps.departmentRepo.findById(targetDeptId);
      if (!dept && input.toDepartmentId) {
        throw notFound(`Departamento ${input.toDepartmentId} no encontrado`);
      }
    }

    const nextStatus = assignedAgent
      ? (aggregate.case.status === "ESCALATED" ? "HUMAN_ACTIVE" : aggregate.case.status)
      : aggregate.case.status;

    const result = await this.deps.caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: nextStatus,
      context: aggregate.case.context,
      currentState: aggregate.workflowInstance.currentState,
      departmentId: targetDeptId,
      expiresAt: aggregate.case.expiresAt,
    });

    await this.deps.caseRepo.setAssignedAgent(
      aggregate.case.id,
      assignedAgent ? assignedAgent.id : null,
    );

    if (this.deps.escalationRepo) {
      const escalation = await this.deps.escalationRepo.findByCaseId(aggregate.case.id);
      if (escalation) {
        await this.deps.escalationRepo.updateAssignment(escalation.id, {
          assignedAgentId: assignedAgent ? assignedAgent.id : null,
          status: assignedAgent ? "ASSIGNED" : "PENDING",
          departmentId: targetDeptId,
        });
      }
    }

    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_TRANSFERRED", {
      toDepartmentId: targetDeptId,
      fromDepartmentId: aggregate.case.departmentId,
      reason,
      assignedAgentId: assignedAgent ? assignedAgent.id : null,
    });

    if (assignedAgent) {
      await this.deps.caseRepo.appendEvent(aggregate.case.id, "HUMAN_ASSIGNED", {
        agentUserId: assignedAgent.id,
        via: input.toAgentId ? "manual_transfer" : "auto_assign",
        departmentId: targetDeptId,
      });
    }

    await this.deps.auditRepo.record({
      action: "CASE_TRANSFERRED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: input.agentUserId,
      metadata: {
        toDepartmentId: targetDeptId,
        reason,
        previousDepartmentId: aggregate.case.departmentId,
        assignedAgentId: assignedAgent ? assignedAgent.id : null,
      },
    });

    if (assignedAgent) {
      await this.deps.auditRepo.record({
        action: input.toAgentId ? "CASE_ASSIGNED" : "CASE_AUTO_ASSIGNED",
        resourceType: "case",
        resourceId: aggregate.case.id,
        actorId: input.agentUserId,
        metadata: {
          assignedAgentId: assignedAgent.id,
          departmentId: targetDeptId,
          reason: input.toAgentId ? "manual_transfer" : "transfer_auto_assign",
        },
      });
    }

    // Registrar respaldo visible en la conversación para trazabilidad del equipo
    if (this.deps.messageRepo) {
      const actor = this.deps.agentRepo
        ? await this.deps.agentRepo.findById(input.agentUserId)
        : null;
      const actorName = actor?.name || "Agente";

      let destinationText = "";
      if (dept && assignedAgent) {
        destinationText = `al área ${dept.name} (${assignedAgent.name})`;
      } else if (assignedAgent) {
        destinationText = `a ${assignedAgent.name}`;
      } else if (dept) {
        destinationText = `al área ${dept.name}`;
      } else {
        destinationText = "a otra área";
      }

      const reasonPart = reason ? `. Motivo: ${reason}` : "";
      const systemMessageText = `Caso transferido ${destinationText} por ${actorName}${reasonPart}`;

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

    if (this.deps.broadcaster) {
      if (assignedAgent) {
        this.deps.broadcaster.publish({
          type: "HUMAN_ASSIGNED",
          caseId: aggregate.case.id,
          agentUserId: assignedAgent.id,
          conversationId: aggregate.case.conversationId,
        });
      } else {
        this.deps.broadcaster.publish({
          type: "HUMAN_UNASSIGNED",
          caseId: aggregate.case.id,
          conversationId: aggregate.case.conversationId,
        });
      }
    }

    this.deps.logger?.info(
      {
        caseId: result.case.id,
        toDepartmentId: targetDeptId,
        assignedAgentId: assignedAgent ? assignedAgent.id : null,
      },
      "caso transferido",
    );

    const fresh = await this.deps.caseRepo.findById(aggregate.case.id);
    return fresh ? fresh.case : result.case;
  }
}
