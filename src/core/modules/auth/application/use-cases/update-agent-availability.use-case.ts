import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DrainDepartmentQueueService } from "../../../escalation/application/services/drain-department-queue.service";

export type UpdateAgentAvailabilityInput = {
  agentId: string;
  autoAssignEnabled?: boolean;
  activeDepartmentIds?: string[];
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
};

export type UpdateAgentAvailabilityDeps = {
  agentRepo: AgentRepositoryPort;
  auditRepo?: AuditRepositoryPort;
  drainQueue?: DrainDepartmentQueueService;
  logger: Logger;
};

/**
 * Permite a cualquier agente autenticado cambiar su propio estado de disponibilidad
 * y colas de departamentos activos en turno para el balanceador automático AutoAssignAgentService.
 */
export class UpdateAgentAvailabilityUseCase {
  constructor(private readonly deps: UpdateAgentAvailabilityDeps) {}

  async execute(input: UpdateAgentAvailabilityInput): Promise<Agent> {
    const current = await this.deps.agentRepo.findById(input.agentId);
    if (!current) {
      throw notFound(`Agente ${input.agentId} no encontrado`);
    }

    const patch: { autoAssignEnabled?: boolean; activeDepartmentIds?: string[] } = {};

    if (input.autoAssignEnabled !== undefined) {
      patch.autoAssignEnabled = input.autoAssignEnabled;
    }

    if (input.activeDepartmentIds !== undefined) {
      const allowed = new Set<string>();
      if (current.primaryDepartmentId) allowed.add(current.primaryDepartmentId);
      for (const dId of current.departmentIds ?? []) allowed.add(dId);

      const filtered = input.activeDepartmentIds.filter((dId) => allowed.has(dId));
      patch.activeDepartmentIds = filtered;

      // Si activa colas de atencion y autoAssignEnabled no fue seteado explicitamente en false,
      // se activa la disponibilidad automaticamente (intencion operativa de entrar al turno).
      if (input.autoAssignEnabled === undefined && filtered.length > 0 && !current.autoAssignEnabled) {
        patch.autoAssignEnabled = true;
      }
    }

    const updated = await this.deps.agentRepo.update(current.id, patch);

    if (this.deps.auditRepo) {
      const switchChanged = current.autoAssignEnabled !== updated.autoAssignEnabled;
      const isSwitchOn = updated.autoAssignEnabled;
      const action = switchChanged
        ? (isSwitchOn ? "AGENT_SHIFT_STARTED" : "AGENT_SHIFT_ENDED")
        : "AGENT_AVAILABILITY_CHANGED";

      await this.deps.auditRepo.record({
        action,
        category: "operational",
        resourceType: "agent",
        resourceId: updated.id,
        actorType: "agent",
        actorId: updated.id,
        departmentId: updated.primaryDepartmentId,
        beforeState: {
          autoAssignEnabled: current.autoAssignEnabled,
          activeDepartmentIds: current.activeDepartmentIds,
        },
        afterState: {
          autoAssignEnabled: updated.autoAssignEnabled,
          activeDepartmentIds: updated.activeDepartmentIds,
        },
        metadata: {
          switch: isSwitchOn ? "ON" : "OFF",
          shiftStatus: isSwitchOn ? "OPEN" : "CLOSED",
          switchChanged,
          previousAutoAssign: current.autoAssignEnabled,
          currentAutoAssign: updated.autoAssignEnabled,
          previousActiveDepartments: current.activeDepartmentIds,
          currentActiveDepartments: updated.activeDepartmentIds,
          description: switchChanged
            ? (isSwitchOn ? "Turno activado (switch ON)" : "Turno cerrado / pausa (switch OFF)")
            : "Colas de atención actualizadas",
        },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        correlationId: input.correlationId,
      });
    }

    this.deps.logger.info(
      { agentId: updated.id, autoAssignEnabled: updated.autoAssignEnabled },
      "disponibilidad de auto-asignación actualizada por el agente",
    );

    if (this.deps.drainQueue && updated.autoAssignEnabled) {
      void this.deps.drainQueue.drainQueueForAgent(updated.id).catch((err) => {
        this.deps.logger.warn({ err, agentId: updated.id }, "error al drenar colas tras activar disponibilidad");
      });
    }

    return updated;
  }
}
