import { businessError, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Department, DepartmentVisibility } from "../../domain/department.entity";
import type { DepartmentCaseRouting, DepartmentHandlingMode } from "../../domain/department-case-routing.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";
import type { DepartmentRoutingService } from "../services/department-routing.service";

export type UpdateDepartmentCaseItem = {
  id?: string;
  label: string;
  description: string;
  intentKey?: string;
  handlingMode?: DepartmentHandlingMode;
  workflowType?: string;
  active?: boolean;
};

export type UpdateDepartmentInput = {
  departmentId: string;
  patch: {
    name?: string;
    slug?: string;
    description?: string | null;
    visibility?: DepartmentVisibility;
    active?: boolean;
    cases?: UpdateDepartmentCaseItem[];
  };
  actorId: string;
};

export type UpdateDepartmentDeps = {
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  routingService?: DepartmentRoutingService;
  logger: Logger;
};

export class UpdateDepartmentUseCase {
  constructor(private readonly deps: UpdateDepartmentDeps) {}

  async execute(input: UpdateDepartmentInput): Promise<Department & { cases?: DepartmentCaseRouting[] }> {
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

    const updated = await this.deps.departmentRepo.update(department.id, {
      name: input.patch.name,
      slug: input.patch.slug,
      description: input.patch.description,
      visibility: input.patch.visibility,
      active: input.patch.active,
    });

    if (input.patch.cases && Array.isArray(input.patch.cases)) {
      const slug = updated.slug;
      for (const item of input.patch.cases) {
        const normalizedLabel = item.label
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");
        const rawIntent = item.intentKey?.trim() || `${slug}.${normalizedLabel}`;

        if (item.id) {
          await this.deps.departmentRepo.updateRouting(item.id, {
            label: item.label,
            description: item.description,
            intentKey: rawIntent,
            handlingMode: item.handlingMode,
            workflowType: item.workflowType,
            active: item.active,
          });
        } else {
          await this.deps.departmentRepo.createRouting({
            departmentId: department.id,
            intentKey: rawIntent,
            label: item.label,
            description: item.description,
            handlingMode: item.handlingMode ?? "ai_assisted",
            workflowType: item.workflowType ?? "GENERAL_INQUIRY",
            active: item.active ?? true,
          });
        }
      }
    }

    if (this.deps.routingService) {
      await this.deps.routingService.invalidateCache();
    }

    const currentCases = await this.deps.departmentRepo.listRoutings(department.id);

    await this.deps.auditRepo.record({
      action: "DEPARTMENT_UPDATED",
      resourceType: "department",
      resourceId: department.id,
      actorId: input.actorId,
      metadata: input.patch,
    });

    this.deps.logger.info({ departmentId: department.id, actorId: input.actorId }, "departamento actualizado");

    return {
      ...updated,
      cases: currentCases,
    };
  }
}
