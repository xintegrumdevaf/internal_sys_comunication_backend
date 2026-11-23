import type { Logger } from "../../../../../shared/logging/logger";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Escalation } from "../../domain/escalation.entity";
import type { EscalationRepositoryPort } from "../ports/escalation.repository.port";
import type { CaseContext } from "../../../cases/domain/contexts/case-context";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";
import type { AutoAssignAgentService } from "./auto-assign-agent.service";

export type EscalatedQueueOverflowDeps = {
  escalationRepo: EscalationRepositoryPort;
  caseRepo: CaseRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  agentRepo: AgentRepositoryPort;
  autoAssign: AutoAssignAgentService;
  messageRepo?: MessageRepositoryPort;
  auditRepo?: AuditRepositoryPort;
  broadcaster?: Pick<RealtimeBroadcaster, "isUserConnected" | "publish">;
  settingsService?: SystemSettingsService;
  logger: Logger;
  defaultMaxConcurrentCases?: number;
};

/**
 * Desborde automático (Overflow) para casos encolados en `ESCALATED` sin asignar
 * cuyo departamento tiene 0 asesores elegibles conectados y supera el umbral de espera
 * (`queueOverflowMinutes`, default 15 min).
 *
 * Prioridad de desborde:
 * 1. `department.fallbackDepartmentId` (si está activo y tiene asesores conectados):
 *    intenta asignar directo a un asesor con cupo, o mueve la cola hacia ese departamento.
 * 2. Si no existe respaldo con asesores conectados, asigna al `manager` conectado en turno
 *    con menor carga activa.
 *
 * Si el departamento origen SÍ tiene asesores conectados (aunque copados), NO desborda
 * y respeta su cola FIFO.
 */
export class EscalatedQueueOverflowService {
  private isRunning = false;

  constructor(private readonly deps: EscalatedQueueOverflowDeps) {}

  async overflowStaleQueues(now: Date = new Date()): Promise<number> {
    if (this.isRunning) return 0;
    this.isRunning = true;

    let overflowedCount = 0;
    try {
      const thresholds = this.deps.settingsService
        ? await this.deps.settingsService.getAiRescueThresholds()
        : { waitingMinutes: 45, stuckMinutes: 5, queueOverflowMinutes: 15 };
      const minWaitMinutes = thresholds.queueOverflowMinutes ?? 15;
      const cutoff = new Date(now.getTime() - minWaitMinutes * 60_000);

      const pending =
        typeof this.deps.escalationRepo.findPendingOlderThan === "function"
          ? await this.deps.escalationRepo.findPendingOlderThan(cutoff, 25)
          : (await this.deps.escalationRepo.list({ status: "PENDING" })).filter(
              (e) => e.assignedAgentId === null && e.createdAt.getTime() <= cutoff.getTime(),
            );

      if (pending.length === 0) {
        return 0;
      }

      const allAgents = await this.deps.agentRepo.list();
      const connectedCache = new Map<string, boolean>();

      for (const escalation of pending) {
        try {
          const moved = await this.processSingleEscalation(
            escalation,
            allAgents,
            connectedCache,
            now,
          );
          if (moved) overflowedCount += 1;
        } catch (err) {
          this.deps.logger.warn(
            { err, escalationId: escalation.id, caseId: escalation.caseId },
            "error procesando desborde de cola sin asesores",
          );
        }
      }

      return overflowedCount;
    } finally {
      this.isRunning = false;
    }
  }

  private async hasConnectedEligibleAgent(
    departmentId: string,
    allAgents: Agent[],
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    if (cache.has(departmentId)) {
      return cache.get(departmentId)!;
    }

    let found = false;
    for (const agent of allAgents) {
      if (!agent.active || !agent.autoAssignEnabled) continue;
      if (agent.role !== "agent" && agent.role !== "manager") continue;
      if (this.deps.broadcaster && !this.deps.broadcaster.isUserConnected(agent.id)) {
        continue;
      }

      if (agent.activeDepartmentIds !== undefined) {
        if (agent.activeDepartmentIds.includes(departmentId)) {
          found = true;
          break;
        }
        continue;
      }

      if (agent.primaryDepartmentId === departmentId) {
        found = true;
        break;
      }

      const belongs = await this.deps.agentRepo.belongsToDepartment(agent.id, departmentId);
      if (belongs) {
        found = true;
        break;
      }
    }

    cache.set(departmentId, found);
    return found;
  }

  private async pickConnectedManager(
    allAgents: Agent[],
    maxConcurrent: number,
  ): Promise<Agent | null> {
    const connectedManagers = allAgents.filter((a) => {
      if (!a.active || !a.autoAssignEnabled) return false;
      if (a.role !== "manager") return false;
      if (this.deps.broadcaster && !this.deps.broadcaster.isUserConnected(a.id)) {
        return false;
      }
      return true;
    });

    if (connectedManagers.length === 0) return null;

    const loads = await this.deps.caseRepo.countActiveCasesByAgent(
      connectedManagers.map((m) => m.id),
    );
    const eligible = connectedManagers.filter((m) => (loads[m.id] ?? 0) < maxConcurrent);
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      const diff = (loads[a.id] ?? 0) - (loads[b.id] ?? 0);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, "es");
    });

    return eligible[0]!;
  }

  private async processSingleEscalation(
    escalation: Escalation,
    allAgents: Agent[],
    connectedCache: Map<string, boolean>,
    now: Date,
  ): Promise<boolean> {
    const aggregate = await this.deps.caseRepo.findById(escalation.caseId);
    if (!aggregate) return false;

    const currentCase = aggregate.case;
    if (currentCase.status !== "ESCALATED" || currentCase.assignedAgentId !== null) {
      return false;
    }

    const conv = await this.deps.conversationRepo.findById(currentCase.conversationId);
    if (!conv || conv.status === "resolved" || conv.status === "closed") {
      return false;
    }

    const sourceDeptId = escalation.departmentId ?? currentCase.departmentId;
    if (sourceDeptId) {
      const hasAgents = await this.hasConnectedEligibleAgent(sourceDeptId, allAgents, connectedCache);
      // Si el departamento origen SÍ tiene agentes conectados (aunque copados), respetamos su FIFO.
      if (hasAgents) {
        return false;
      }
    }

    const sourceDept = sourceDeptId ? await this.deps.departmentRepo.findById(sourceDeptId) : null;
    const sourceName = sourceDept?.name ?? "General / Triaje";
    const waitMinutes = Math.max(
      1,
      Math.round((now.getTime() - escalation.createdAt.getTime()) / 60_000),
    );

    // 1. Intentar desborde hacia fallbackDepartmentId configurado
    if (sourceDept?.fallbackDepartmentId && sourceDept.fallbackDepartmentId !== sourceDept.id) {
      const fallbackDept = await this.deps.departmentRepo.findById(sourceDept.fallbackDepartmentId);
      if (fallbackDept && fallbackDept.active) {
        const fallbackHasAgents = await this.hasConnectedEligibleAgent(
          fallbackDept.id,
          allAgents,
          connectedCache,
        );

        if (fallbackHasAgents) {
          const chosenAgent = await this.deps.autoAssign.pickAgentForDepartment(fallbackDept.id);
          await this.applyOverflowMove({
            escalation,
            caseAggregateVersion: currentCase.version,
            workflowVersion: aggregate.workflowInstance.version,
            workflowState: aggregate.workflowInstance.currentState,
            caseContext: currentCase.context,
            expiresAt: currentCase.expiresAt,
            conversationId: conv.id,
            sourceDeptId,
            sourceName,
            targetDeptId: fallbackDept.id,
            targetDeptName: fallbackDept.name,
            assignedAgent: chosenAgent,
            waitMinutes,
            overflowMode: chosenAgent ? "fallback_department_assigned" : "fallback_department_queued",
          });
          return true;
        }
      }
    }

    // 2. Fallback final: supervisor (manager) conectado con turno activo y menor carga
    const maxConcurrent =
      sourceDept?.maxConcurrentCases ?? this.deps.defaultMaxConcurrentCases ?? 6;
    const manager = await this.pickConnectedManager(allAgents, maxConcurrent);
    if (!manager) {
      return false;
    }

    await this.applyOverflowMove({
      escalation,
      caseAggregateVersion: currentCase.version,
      workflowVersion: aggregate.workflowInstance.version,
      workflowState: aggregate.workflowInstance.currentState,
      caseContext: currentCase.context,
      expiresAt: currentCase.expiresAt,
      conversationId: conv.id,
      sourceDeptId,
      sourceName,
      targetDeptId: sourceDeptId,
      targetDeptName: sourceName,
      assignedAgent: manager,
      waitMinutes,
      overflowMode: "manager_fallback",
    });

    return true;
  }

  private async applyOverflowMove(input: {
    escalation: Escalation;
    caseAggregateVersion: number;
    workflowVersion: number;
    workflowState: string;
    caseContext: CaseContext;
    expiresAt: Date | null;
    conversationId: string;
    sourceDeptId: string | null;
    sourceName: string;
    targetDeptId: string | null;
    targetDeptName: string;
    assignedAgent: Agent | null;
    waitMinutes: number;
    overflowMode: "fallback_department_assigned" | "fallback_department_queued" | "manager_fallback";
  }): Promise<void> {
    const nextStatus = input.assignedAgent ? "HUMAN_ACTIVE" : "ESCALATED";

    await this.deps.caseRepo.applyTransition({
      caseId: input.escalation.caseId,
      expectedCaseVersion: input.caseAggregateVersion,
      expectedWorkflowVersion: input.workflowVersion,
      status: nextStatus,
      context: input.caseContext,
      currentState: input.workflowState,
      departmentId: input.targetDeptId,
      expiresAt: input.expiresAt,
    });

    if (input.assignedAgent) {
      await this.deps.caseRepo.setAssignedAgent(input.escalation.caseId, input.assignedAgent.id);
      await this.deps.escalationRepo.updateAssignment(input.escalation.id, {
        assignedAgentId: input.assignedAgent.id,
        status: "ASSIGNED",
        departmentId: input.targetDeptId,
      });
      await this.deps.caseRepo.setAutomationEnabled(input.escalation.caseId, false, {
        reason: "QUEUE_OVERFLOW",
      });
    } else {
      await this.deps.escalationRepo.updateAssignment(input.escalation.id, {
        assignedAgentId: null,
        status: "PENDING",
        departmentId: input.targetDeptId,
      });
    }

    const systemText =
      input.overflowMode === "fallback_department_assigned" && input.assignedAgent
        ? `↪️ Desbordado automáticamente a ${input.assignedAgent.name} (${input.targetDeptName}) tras ${input.waitMinutes} min sin asesores conectados en ${input.sourceName}.`
        : input.overflowMode === "fallback_department_queued"
          ? `↪️ Movido automáticamente a la cola de ${input.targetDeptName} tras ${input.waitMinutes} min sin asesores conectados en ${input.sourceName}.`
          : `↪️ Asignado automáticamente a supervisión (${input.assignedAgent?.name ?? "Supervisor"}) tras ${input.waitMinutes} min sin asesores conectados en ${input.sourceName}.`;

    if (this.deps.messageRepo) {
      const sysMessage = await this.deps.messageRepo.insertOutbound({
        conversationId: input.conversationId,
        author: "system",
        body: systemText,
        caseId: input.escalation.caseId,
        status: "sent",
      });
      this.deps.broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: input.conversationId,
        messageId: sysMessage.id,
        author: "system",
      });
    }

    await this.deps.caseRepo.appendEvent(input.escalation.caseId, "CASE_QUEUE_OVERFLOW", {
      overflowMode: input.overflowMode,
      fromDepartmentId: input.sourceDeptId,
      toDepartmentId: input.targetDeptId,
      assignedAgentId: input.assignedAgent?.id ?? null,
      waitMinutes: input.waitMinutes,
    });

    if (input.assignedAgent) {
      await this.deps.caseRepo.appendEvent(input.escalation.caseId, "HUMAN_ASSIGNED", {
        agentUserId: input.assignedAgent.id,
        via: "queue_overflow",
        departmentId: input.targetDeptId,
      });
      this.deps.broadcaster?.publish({
        type: "HUMAN_ASSIGNED",
        caseId: input.escalation.caseId,
        agentUserId: input.assignedAgent.id,
      });
    }

    await this.deps.auditRepo?.record({
      action: "CASE_QUEUE_OVERFLOW",
      resourceType: "case",
      resourceId: input.escalation.caseId,
      actorId: null,
      metadata: {
        overflowMode: input.overflowMode,
        fromDepartmentId: input.sourceDeptId,
        toDepartmentId: input.targetDeptId,
        assignedAgentId: input.assignedAgent?.id ?? null,
        waitMinutes: input.waitMinutes,
      },
    });

    this.deps.logger.info(
      {
        caseId: input.escalation.caseId,
        overflowMode: input.overflowMode,
        fromDepartmentId: input.sourceDeptId,
        toDepartmentId: input.targetDeptId,
        assignedAgentId: input.assignedAgent?.id ?? null,
        waitMinutes: input.waitMinutes,
      },
      "caso encolado desbordado automáticamente por falta de asesores conectados",
    );
  }
}
