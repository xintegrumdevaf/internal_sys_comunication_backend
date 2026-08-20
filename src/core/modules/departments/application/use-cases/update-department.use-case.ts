import { businessError, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Department, DepartmentVisibility } from "../../domain/department.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";

export type UpdateDepartmentInput = {
  departmentId: string;
  patch: {
    name?: string;
    slug?: string;
    visibility?: DepartmentVisibility;
    active?: boolean;
  };
  actorId: string;
};

export type UpdateDepartmentDeps = {
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

export class UpdateDepartmentUseCase {
  constructor(private readonly deps: UpdateDepartmentDeps) {}

  async execute(input: UpdateDepartmentInput): Promise<Department> {
    const department = await this.deps.departmentRepo.findById(input.departmentId);
    if (!department) {
      throw validationError(`El departamento ${input.departmentId} no existe`);
    }

    if (input.patch.slug && input.patch.slug !== department.slug) {
      const existingSlug = await this.deps.departmentRepo.findBySlug(input.patch.slug);
      if (existingSlug) {
        throw businessError(`Ya existe otro departamento con el slug ${input.patch.slug}`);
      }
    }

    const updated = await this.deps.departmentRepo.update(department.id, input.patch);

    await this.deps.auditRepo.record({
      action: "DEPARTMENT_UPDATED",
      resourceType: "department",
      resourceId: department.id,
      actorId: input.actorId,
      metadata: input.patch,
    });

    this.deps.logger.info({ departmentId: department.id, actorId: input.actorId }, "departamento actualizado");

    return updated;
  }
}
