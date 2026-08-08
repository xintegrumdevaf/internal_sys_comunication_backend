import type { Department } from "../../domain/department.entity";

export type CreateDepartmentInput = {
  slug: string;
  name: string;
};

export interface DepartmentRepositoryPort {
  list(): Promise<Department[]>;
  findBySlug(slug: string): Promise<Department | null>;
  create(input: CreateDepartmentInput): Promise<Department>;
}
