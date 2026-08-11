import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Agent } from "../../domain/agent.entity";
import type { AgentRepositoryPort } from "../ports/agent.repository.port";
import { assertKeepsAtLeastOneActiveAdmin } from "./agent-guardrails";

export type DeactivateAgentInput = {
  agentId: string;
  /** Admin que ejecuta la baja (para audit_event). */
  actorId: string;
};

export type DeactivateAgentDeps = {
  agentRepo: AgentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

/**
 * docs/spec/06_BACKEND_GAPS.md §1 `DELETE /api/agents/:id` — soft delete
 * (pone `active=false`, nunca borra la fila: los casos/audit_event ya
 * referencian a este agente por id). Restringido a role=admin en
 * agents-admin.router.ts.
 */
export class DeactivateAgentUseCase {
  constructor(private readonly deps: DeactivateAgentDeps) {}

  async execute(input: DeactivateAgentInput): Promise<Agent> {
    const agent = await this.deps.agentRepo.findById(input.agentId);
    if (!agent) {
      throw notFound(`Agente ${input.agentId} no encontrado`);
    }

    if (!agent.active) {
      return agent; // idempotente: ya estaba desactivado
    }

    await assertKeepsAtLeastOneActiveAdmin(this.deps.agentRepo, agent, { active: false });

    const updated = await this.deps.agentRepo.update(agent.id, { active: false });

    await this.deps.auditRepo.record({
      action: "AGENT_DEACTIVATED",
      resourceType: "agent",
      resourceId: agent.id,
      actorId: input.actorId,
      metadata: {},
    });
    this.deps.logger.info({ agentId: agent.id, actorId: input.actorId }, "agente desactivado");

    return updated;
  }
}
