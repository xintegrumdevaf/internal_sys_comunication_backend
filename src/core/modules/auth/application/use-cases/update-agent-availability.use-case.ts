import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";

export type UpdateAgentAvailabilityInput = {
  agentId: string;
  autoAssignEnabled: boolean;
};

export type UpdateAgentAvailabilityDeps = {
  agentRepo: AgentRepositoryPort;
  auditRepo?: AuditRepositoryPort;
  logger: Logger;
};

/**
 * Permite a cualquier agente autenticado cambiar su propio estado de disponibilidad
 * (desconexión / pausa para el balanceador automático AutoAssignAgentService).
 */
export class UpdateAgentAvailabilityUseCase {
  constructor(private readonly deps: UpdateAgentAvailabilityDeps) {}

  async execute(input: UpdateAgentAvailabilityInput): Promise<Agent> {
    const current = await this.deps.agentRepo.findById(input.agentId);
    if (!current) {
      throw notFound(`Agente ${input.agentId} no encontrado`);
    }

    const updated = await this.deps.agentRepo.update(current.id, {
      autoAssignEnabled: input.autoAssignEnabled,
    });

    if (this.deps.auditRepo) {
      await this.deps.auditRepo.record({
        action: "AGENT_AVAILABILITY_CHANGED",
        resourceType: "agent",
        resourceId: updated.id,
        actorId: updated.id,
        metadata: {
          previous: current.autoAssignEnabled,
          current: updated.autoAssignEnabled,
        },
      });
    }

    this.deps.logger.info(
      { agentId: updated.id, autoAssignEnabled: updated.autoAssignEnabled },
      "disponibilidad de auto-asignación actualizada por el agente",
    );

    return updated;
  }
}
