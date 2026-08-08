import type { Department } from "../../domain/department.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";

export class ListDepartmentsUseCase {
  constructor(private readonly departmentRepo: DepartmentRepositoryPort) {}

  async execute(): Promise<Department[]> {
    return this.departmentRepo.list();
  }
}
