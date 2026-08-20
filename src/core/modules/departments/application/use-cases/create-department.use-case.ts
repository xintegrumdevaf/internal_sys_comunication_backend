import { businessError, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Department, DepartmentVisibility } from "../../domain/department.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";

export type CreateDepartmentInput = {
  name: string;
  slug: string;
  visibility?: DepartmentVisibility;
  actorId: string;
};

export type CreateDepartmentDeps = {
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

export class CreateDepartmentUseCase {
  constructor(private readonly deps: CreateDepartmentDeps) {}

  async execute(input: CreateDepartmentInput): Promise<Department> {
    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();

    if (name.length < 2) {
      throw validationError("El nombre del departamento debe tener al menos 2 caracteres");
    }

    if (slug.length < 2) {
      throw validationError("El slug del departamento debe tener al menos 2 caracteres");
    }

    const existing = await this.deps.departmentRepo.findBySlug(slug);
    if (existing) {
      throw businessError(`Ya existe un departamento con el slug ${slug}`);
    }

    const department = await this.deps.departmentRepo.create({
      name,
      slug,
      visibility: input.visibility ?? "shared",
    });

    await this.deps.auditRepo.record({
      action: "DEPARTMENT_CREATED",
      resourceType: "department",
      resourceId: department.id,
      actorId: input.actorId,
      metadata: {
        slug: department.slug,
        visibility: department.visibility,
      },
    });

    this.deps.logger.info({ departmentId: department.id, actorId: input.actorId }, "departamento creado");

    return department;
  }
}
