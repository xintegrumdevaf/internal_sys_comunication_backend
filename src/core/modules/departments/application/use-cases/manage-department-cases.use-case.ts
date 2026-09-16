import { validationError } from "../../../../../shared/errors/domain-errors";
import type { DepartmentCaseRouting, DepartmentHandlingMode } from "../../domain/department-case-routing.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";
import type { DepartmentRoutingService } from "../services/department-routing.service";
import { inferWorkflowType } from "../services/workflow-type-inference";

export type AddDepartmentCaseInput = {
  departmentId: string;
  label: string;
  description: string;
  intentKey?: string;
  handlingMode?: DepartmentHandlingMode;
  workflowType?: string;
};

export class AddDepartmentCaseUseCase {
  constructor(
    private readonly departmentRepo: DepartmentRepositoryPort,
    private readonly routingService?: DepartmentRoutingService,
  ) {}

  async execute(input: AddDepartmentCaseInput): Promise<DepartmentCaseRouting> {
    const dept = await this.departmentRepo.findById(input.departmentId);
    if (!dept) {
      throw validationError(`El departamento ${input.departmentId} no existe`);
    }

    const normalizedLabel = input.label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    const rawIntent = input.intentKey?.trim() || `${dept.slug}.${normalizedLabel}`;

    const created = await this.departmentRepo.createRouting({
      departmentId: dept.id,
      intentKey: rawIntent,
      label: input.label.trim(),
      description: input.description.trim(),
      handlingMode: input.handlingMode ?? "ai_assisted",
      workflowType: inferWorkflowType(
        dept.slug,
        dept.name,
        input.label,
        input.description,
        rawIntent,
        input.workflowType,
      ),
      active: true,
    });

    if (this.routingService) {
      await this.routingService.invalidateCache();
    }

    return created;
  }
}

export class DeleteDepartmentCaseUseCase {
  constructor(
    private readonly departmentRepo: DepartmentRepositoryPort,
    private readonly routingService?: DepartmentRoutingService,
  ) {}

  async execute(caseRoutingId: string): Promise<void> {
    await this.departmentRepo.deleteRouting(caseRoutingId);
    if (this.routingService) {
      await this.routingService.invalidateCache();
    }
  }
}

export class ListDepartmentCasesUseCase {
  constructor(private readonly departmentRepo: DepartmentRepositoryPort) {}

  async execute(departmentId?: string): Promise<DepartmentCaseRouting[]> {
    return this.departmentRepo.listRoutings(departmentId);
  }
}
