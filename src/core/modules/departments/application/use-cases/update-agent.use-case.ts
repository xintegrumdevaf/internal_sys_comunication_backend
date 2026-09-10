import { notFound, validationError, businessError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Agent } from "../../domain/agent.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";
import type { AgentRepositoryPort, UpdateAgentPatch } from "../ports/agent.repository.port";
import { assertKeepsAtLeastOneActiveAdmin } from "./agent-guardrails";

export type UpdateAgentInput = {
  agentId: string;
  patch: UpdateAgentPatch;
  /** Admin que ejecuta el cambio (para audit_event). */
  actorId: string;
};

export type UpdateAgentDeps = {
  agentRepo: AgentRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

/**
 * docs/spec/06_BACKEND_GAPS.md §1 `PUT /api/agents/:id`. Restringido a
 * role=admin en la capa de presentation (agents-admin.router.ts).
 */
export class UpdateAgentUseCase {
  constructor(private readonly deps: UpdateAgentDeps) {}

  async execute(input: UpdateAgentInput): Promise<Agent> {
    const current = await this.deps.agentRepo.findById(input.agentId);
    if (!current) {
      throw notFound(`Agente ${input.agentId} no encontrado`);
    }

    const patch: UpdateAgentPatch = { ...input.patch };

    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (trimmed.length < 2) {
        throw validationError("El nombre del agente debe tener al menos 2 caracteres");
      }
      patch.name = trimmed;
    }

    if (patch.email !== undefined) {
      const normalized = patch.email.trim().toLowerCase();
      const existing = await this.deps.agentRepo.findByEmail(normalized);
      if (existing && existing.id !== current.id) {
        throw businessError(`Ya existe un agente con el correo ${normalized}`);
      }
      patch.email = normalized;
    }

    if (patch.primaryDepartmentId) {
      const department = await this.deps.departmentRepo.findById(patch.primaryDepartmentId);
      if (!department) {
        throw validationError(`El departamento ${patch.primaryDepartmentId} no existe`);
      }
    }

    if (patch.departmentIds && patch.departmentIds.length > 0) {
      for (const deptId of patch.departmentIds) {
        const department = await this.deps.departmentRepo.findById(deptId);
        if (!department) {
          throw validationError(`El departamento ${deptId} no existe`);
        }
      }
    }

    await assertKeepsAtLeastOneActiveAdmin(this.deps.agentRepo, current, {
      active: patch.active,
      role: patch.role,
    });

    const updated = await this.deps.agentRepo.update(current.id, patch);

    await this.deps.auditRepo.record({
      action: "AGENT_UPDATED",
      resourceType: "agent",
      resourceId: updated.id,
      actorId: input.actorId,
      metadata: { changed: Object.keys(input.patch) },
    });
    this.deps.logger.info({ agentId: updated.id, actorId: input.actorId }, "agente actualizado");

    return updated;
  }
}
