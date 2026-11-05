import type { Logger } from "../../../../../shared/logging/logger";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { EscalationRepositoryPort } from "../ports/escalation.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export type DrainDepartmentQueueDeps = {
  agentRepo: AgentRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  caseRepo: CaseRepositoryPort;
  escalationRepo: EscalationRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  auditRepo?: AuditRepositoryPort;
  broadcaster?: Pick<RealtimeBroadcaster, "isUserConnected" | "publish">;
  logger: Logger;
  defaultMaxConcurrentCases?: number;
};

/**
 * Servicio de despacho progresivo (Paced FIFO Dispatch / Concurrency Cap).
 * Drena de forma atómica y equitativa los casos pendientes encolados en un
 * departamento hacia asesores en turno que dispongan de cupo libre.
 */
export class DrainDepartmentQueueService {
  constructor(private readonly deps: DrainDepartmentQueueDeps) {}

  /**
   * Drena los casos encolados de un departamento hasta agotar la capacidad
   * disponible de los asesores elegibles conectados en ese departamento.
   */
  async drainQueueForDepartment(departmentId: string): Promise<number> {
    const log = this.deps.logger.child({ departmentId, action: "drainQueueForDepartment" });

    const department = await this.deps.departmentRepo.findById(departmentId);
    if (!department || !department.active) {
      return 0;
    }

    const maxConcurrency = department.maxConcurrentCases ?? this.deps.defaultMaxConcurrentCases ?? 6;

    // 1. Filtrar agentes elegibles del departamento (conectados, con auto-assign activo)
    const allAgents = await this.deps.agentRepo.list();
    const roleEligible = allAgents.filter((a) => {
      if (!a.active || !a.autoAssignEnabled) return false;
      if (a.role !== "agent" && a.role !== "manager") return false;
      if (this.deps.broadcaster && !this.deps.broadcaster.isUserConnected(a.id)) {
        return false;
      }
      return true;
    });

    const eligible: Agent[] = [];
    for (const agent of roleEligible) {
      if (agent.activeDepartmentIds !== undefined) {
        if (agent.activeDepartmentIds.includes(departmentId)) {
          eligible.push(agent);
        }
        continue;
      }
      if (agent.primaryDepartmentId === departmentId) {
        eligible.push(agent);
        continue;
      }
      const belongs = await this.deps.agentRepo.belongsToDepartment(agent.id, departmentId);
      if (belongs) eligible.push(agent);
    }

    if (eligible.length === 0) {
      log.debug("sin asesores elegibles conectados en el departamento para drenar");
      return 0;
    }

    // 2. Medir carga actual en HUMAN_ACTIVE y calcular cupos disponibles
    const loads = await this.deps.caseRepo.countActiveCasesByAgent(eligible.map((a) => a.id));
    const availableSlots: Record<string, number> = {};
    let totalCapacity = 0;

    for (const agent of eligible) {
      const currentLoad = loads[agent.id] ?? 0;
      const freeSlots = Math.max(0, maxConcurrency - currentLoad);
      availableSlots[agent.id] = freeSlots;
      totalCapacity += freeSlots;
    }

    if (totalCapacity <= 0) {
      log.debug({ maxConcurrency, loads }, "todos los asesores elegibles están copados a su capacidad máxima");
      return 0;
    }

    // 3. Obtener casos encolados pendientes con bloqueo atómico FOR UPDATE SKIP LOCKED
    const pendingEscalations = await this.deps.escalationRepo.findNextPendingForDepartment(
      departmentId,
      totalCapacity,
    );

    if (pendingEscalations.length === 0) {
      return 0;
    }

    let assignedCount = 0;

    // 4. Repartir equitativamente (Least-Connections) entre agentes con cupo libre
    for (const escalation of pendingEscalations) {
      // Filtrar asesores que aún tengan cupos libres en esta ronda
      const candidates = eligible.filter((a) => (availableSlots[a.id] ?? 0) > 0);
      if (candidates.length === 0) break;

      // Ordenar por menor carga activa acumulada (desempate por nombre)
      candidates.sort((a, b) => {
        const diff = (loads[a.id] ?? 0) - (loads[b.id] ?? 0);
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name, "es");
      });

      const chosenAgent = candidates[0]!;

      // Asignar caso y pasar a HUMAN_ACTIVE
      await this.deps.caseRepo.setAssignedAgent(escalation.caseId, chosenAgent.id);

      const aggregate = await this.deps.caseRepo.findById(escalation.caseId);
      if (aggregate && aggregate.case.status === "ESCALATED") {
        await this.deps.caseRepo.applyTransition({
          caseId: escalation.caseId,
          expectedCaseVersion: aggregate.case.version,
          expectedWorkflowVersion: aggregate.workflowInstance.version,
          status: "HUMAN_ACTIVE",
          context: aggregate.case.context,
          currentState: aggregate.workflowInstance.currentState,
          expiresAt: aggregate.case.expiresAt,
        });
      }

      await this.deps.escalationRepo.updateAssignment(escalation.id, {
        assignedAgentId: chosenAgent.id,
        status: "ASSIGNED",
      });

      await this.deps.caseRepo.setAutomationEnabled(escalation.caseId, false, {
        reason: "AUTO_ASSIGNED",
      });
      await this.deps.caseRepo.appendEvent(escalation.caseId, "AUTOMATION_DISABLED", {
        reason: "AUTO_ASSIGNED",
      });

      if (aggregate) {
        await this.deps.conversationRepo.setActiveCaseId(aggregate.case.conversationId, escalation.caseId);
        this.deps.broadcaster?.publish({
          type: "AUTOMATION_DISABLED",
          caseId: escalation.caseId,
          conversationId: aggregate.case.conversationId,
        });
      }

      await this.deps.caseRepo.appendEvent(escalation.caseId, "HUMAN_ASSIGNED", {
        agentUserId: chosenAgent.id,
        via: "auto_assign",
        reason: "queue_drain",
      });

      await this.deps.auditRepo?.record({
        action: "CASE_AUTO_ASSIGNED",
        resourceType: "case",
        resourceId: escalation.caseId,
        actorId: null,
        metadata: {
          assignedAgentId: chosenAgent.id,
          departmentId,
          via: "queue_drain",
        },
      });

      this.deps.broadcaster?.publish({
        type: "HUMAN_ASSIGNED",
        caseId: escalation.caseId,
        agentUserId: chosenAgent.id,
      });

      // Actualizar contadores locales para el siguiente caso en el bucle
      loads[chosenAgent.id] = (loads[chosenAgent.id] ?? 0) + 1;
      availableSlots[chosenAgent.id] = (availableSlots[chosenAgent.id] ?? 1) - 1;
      assignedCount++;

      log.info(
        { caseId: escalation.caseId, agentId: chosenAgent.id, currentLoad: loads[chosenAgent.id] },
        "caso encolado asignado exitosamente en drenaje progresivo",
      );
    }

    return assignedCount;
  }

  /**
   * Drena los departamentos en los que participa un agente en particular
   * (llamado cuando un agente se conecta, activa su disponibilidad o libera cupos).
   */
  async drainQueueForAgent(agentId: string): Promise<number> {
    const agent = await this.deps.agentRepo.findById(agentId);
    if (!agent || !agent.active || !agent.autoAssignEnabled) {
      return 0;
    }

    const deptIds = new Set<string>();
    if (agent.activeDepartmentIds && agent.activeDepartmentIds.length > 0) {
      for (const d of agent.activeDepartmentIds) deptIds.add(d);
    } else {
      if (agent.primaryDepartmentId) deptIds.add(agent.primaryDepartmentId);
      const allDepts = await this.deps.departmentRepo.list();
      for (const dept of allDepts) {
        const belongs = await this.deps.agentRepo.belongsToDepartment(agent.id, dept.id);
        if (belongs) deptIds.add(dept.id);
      }
    }

    let totalDrained = 0;
    for (const deptId of deptIds) {
      totalDrained += await this.drainQueueForDepartment(deptId);
    }
    return totalDrained;
  }
}

