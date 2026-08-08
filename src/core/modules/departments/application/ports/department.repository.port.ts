import type { Department, DepartmentVisibility } from "../../domain/department.entity";

export type CreateDepartmentInput = {
  slug: string;
  name: string;
  visibility?: DepartmentVisibility;
};

export interface DepartmentRepositoryPort {
  list(): Promise<Department[]>;
  findBySlug(slug: string): Promise<Department | null>;
  findById(id: string): Promise<Department | null>;
  create(input: CreateDepartmentInput): Promise<Department>;
}
