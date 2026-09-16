import { businessError, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Department, DepartmentVisibility } from "../../domain/department.entity";
import type { DepartmentCaseRouting, DepartmentHandlingMode } from "../../domain/department-case-routing.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";
import type { DepartmentRoutingService } from "../services/department-routing.service";

import { inferWorkflowType } from "../services/workflow-type-inference";

export type CreateDepartmentCaseItem = {
  label: string;
  description: string;
  intentKey?: string;
  handlingMode?: DepartmentHandlingMode;
  workflowType?: string;
};

export type CreateDepartmentInput = {
  name: string;
  slug: string;
  description?: string | null;
  visibility?: DepartmentVisibility;
  actorId: string;
  cases?: CreateDepartmentCaseItem[];
};

export type CreateDepartmentDeps = {
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  routingService?: DepartmentRoutingService;
  logger: Logger;
};

export class CreateDepartmentUseCase {
  constructor(private readonly deps: CreateDepartmentDeps) {}

  async execute(input: CreateDepartmentInput): Promise<Department & { cases?: DepartmentCaseRouting[] }> {
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
      description: input.description?.trim() || null,
      visibility: input.visibility ?? "shared",
    });

    const createdCases: DepartmentCaseRouting[] = [];

    if (input.cases && input.cases.length > 0) {
      for (const item of input.cases) {
        const normalizedLabel = item.label
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");
        const rawIntent = item.intentKey?.trim() || `${slug}.${normalizedLabel}`;
        const createdRouting = await this.deps.departmentRepo.createRouting({
          departmentId: department.id,
          intentKey: rawIntent,
          label: item.label.trim(),
          description: item.description.trim(),
          handlingMode: item.handlingMode ?? "ai_assisted",
          workflowType: inferWorkflowType(
            slug,
            name,
            item.label,
            item.description,
            rawIntent,
            item.workflowType,
          ),
          active: true,
        });
        createdCases.push(createdRouting);
      }
    }

    if (this.deps.routingService) {
      await this.deps.routingService.invalidateCache();
    }

    await this.deps.auditRepo.record({
      action: "DEPARTMENT_CREATED",
      resourceType: "department",
      resourceId: department.id,
      actorId: input.actorId,
      metadata: {
        slug: department.slug,
        visibility: department.visibility,
        casesCount: createdCases.length,
      },
    });

    this.deps.logger.info(
      { departmentId: department.id, actorId: input.actorId, casesCount: createdCases.length },
      "departamento creado con catalogo de casos",
    );

    return {
      ...department,
      cases: createdCases,
    };
  }
}
