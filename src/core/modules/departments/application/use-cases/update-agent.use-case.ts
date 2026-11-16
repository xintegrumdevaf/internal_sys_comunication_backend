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
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
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

    const switchChanged =
      patch.autoAssignEnabled !== undefined &&
      patch.autoAssignEnabled !== current.autoAssignEnabled;

    if (switchChanged) {
      const isSwitchOn = updated.autoAssignEnabled;
      await this.deps.auditRepo.record({
        action: isSwitchOn ? "AGENT_SHIFT_STARTED" : "AGENT_SHIFT_ENDED",
        category: "operational",
        resourceType: "agent",
        resourceId: updated.id,
        actorType: "agent",
        actorId: input.actorId,
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
          previousAutoAssign: current.autoAssignEnabled,
          currentAutoAssign: updated.autoAssignEnabled,
          targetAgentId: updated.id,
          targetAgentName: updated.name,
          targetAgentEmail: updated.email,
          changedByAdmin: true,
          description: isSwitchOn
            ? `Turno activado (switch ON) para ${updated.name} por administrador`
            : `Turno cerrado (switch OFF) para ${updated.name} por administrador`,
        },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        correlationId: input.correlationId,
      });
    }

    await this.deps.auditRepo.record({
      action: "AGENT_UPDATED",
      category: "data_change",
      resourceType: "agent",
      resourceId: updated.id,
      actorType: "agent",
      actorId: input.actorId,
      departmentId: updated.primaryDepartmentId,
      beforeState: {
        name: current.name,
        email: current.email,
        role: current.role,
        primaryDepartmentId: current.primaryDepartmentId,
        departmentIds: current.departmentIds,
        active: current.active,
        autoAssignEnabled: current.autoAssignEnabled,
      },
      afterState: {
        name: updated.name,
        email: updated.email,
        role: updated.role,
        primaryDepartmentId: updated.primaryDepartmentId,
        departmentIds: updated.departmentIds,
        active: updated.active,
        autoAssignEnabled: updated.autoAssignEnabled,
      },
      metadata: {
        changed: Object.keys(input.patch),
        targetAgentId: updated.id,
        targetAgentName: updated.name,
      },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      correlationId: input.correlationId,
    });
    this.deps.logger.info({ agentId: updated.id, actorId: input.actorId }, "agente actualizado");

    return updated;
  }
}
