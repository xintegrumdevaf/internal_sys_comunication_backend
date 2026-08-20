import { businessError, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Department } from "../../domain/department.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";

export type DeactivateDepartmentInput = {
  departmentId: string;
  actorId: string;
};

export type DeactivateDepartmentDeps = {
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

export class DeactivateDepartmentUseCase {
  constructor(private readonly deps: DeactivateDepartmentDeps) {}

  async execute(input: DeactivateDepartmentInput): Promise<Department> {
    const department = await this.deps.departmentRepo.findById(input.departmentId);
    if (!department) {
      throw validationError(`El departamento ${input.departmentId} no existe`);
    }

    if (!department.active) {
      return department; // ya esta desactivado
    }

    const hasAgents = await this.deps.departmentRepo.hasActiveAgents(department.id);
    if (hasAgents) {
      throw businessError(
        "No se puede desactivar el departamento porque tiene agentes activos. Reasigna a los agentes primero."
      );
    }

    const hasCases = await this.deps.departmentRepo.hasOpenCases(department.id);
    if (hasCases) {
      throw businessError(
        "No se puede desactivar el departamento porque tiene casos sin resolver asignados. Ciérralos o transfiérelos primero."
      );
    }

    const deactivated = await this.deps.departmentRepo.deactivate(department.id);

    await this.deps.auditRepo.record({
      action: "DEPARTMENT_DEACTIVATED",
      resourceType: "department",
      resourceId: department.id,
      actorId: input.actorId,
      metadata: { reason: "Soft delete solicitado por admin" },
    });

    this.deps.logger.info({ departmentId: department.id, actorId: input.actorId }, "departamento desactivado");

    return deactivated;
  }
}
