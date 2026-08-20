import type { Department, DepartmentVisibility } from "../../domain/department.entity";

export type CreateDepartmentInput = {
  slug: string;
  name: string;
  visibility?: DepartmentVisibility;
};

export type UpdateDepartmentInput = Partial<CreateDepartmentInput> & {
  active?: boolean;
};

export interface DepartmentRepositoryPort {
  list(): Promise<Department[]>;
  findBySlug(slug: string): Promise<Department | null>;
  findById(id: string): Promise<Department | null>;
  create(input: CreateDepartmentInput): Promise<Department>;
  update(id: string, input: UpdateDepartmentInput): Promise<Department>;
  deactivate(id: string): Promise<Department>;
  hasActiveAgents(id: string): Promise<boolean>;
  hasOpenCases(id: string): Promise<boolean>;
}
