import type { Department, DepartmentVisibility } from "../../domain/department.entity";
import type {
  DepartmentCaseRouting,
  DepartmentHandlingMode,
} from "../../domain/department-case-routing.entity";

export type CreateDepartmentInput = {
  slug: string;
  name: string;
  description?: string | null;
  visibility?: DepartmentVisibility;
};

export type UpdateDepartmentInput = Partial<CreateDepartmentInput> & {
  active?: boolean;
};

export type CreateDepartmentCaseRoutingInput = {
  departmentId: string;
  intentKey: string;
  label: string;
  description: string;
  handlingMode?: DepartmentHandlingMode;
  workflowType?: string;
  active?: boolean;
};

export type UpdateDepartmentCaseRoutingInput = Partial<
  Omit<CreateDepartmentCaseRoutingInput, "departmentId">
>;

export interface DepartmentRepositoryPort {
  list(): Promise<Department[]>;
  findBySlug(slug: string): Promise<Department | null>;
  findById(id: string): Promise<Department | null>;
  create(input: CreateDepartmentInput): Promise<Department>;
  update(id: string, input: UpdateDepartmentInput): Promise<Department>;
  deactivate(id: string): Promise<Department>;
  hasActiveAgents(id: string): Promise<boolean>;
  hasOpenCases(id: string): Promise<boolean>;

  // --- Enrutamiento de casos e intenciones ---
  listRoutings(departmentId?: string): Promise<DepartmentCaseRouting[]>;
  createRouting(input: CreateDepartmentCaseRoutingInput): Promise<DepartmentCaseRouting>;
  updateRouting(id: string, input: UpdateDepartmentCaseRoutingInput): Promise<DepartmentCaseRouting>;
  deleteRouting(id: string): Promise<void>;
  findRoutingByIntent(intentKey: string): Promise<DepartmentCaseRouting | null>;
}
