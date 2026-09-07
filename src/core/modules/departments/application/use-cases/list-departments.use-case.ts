import type { Department } from "../../domain/department.entity";
import type { DepartmentCaseRouting } from "../../domain/department-case-routing.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";

export type DepartmentWithCases = Department & {
  cases: DepartmentCaseRouting[];
};

export class ListDepartmentsUseCase {
  constructor(private readonly departmentRepo: DepartmentRepositoryPort) {}

  async execute(): Promise<DepartmentWithCases[]> {
    const [departments, routings] = await Promise.all([
      this.departmentRepo.list(),
      this.departmentRepo.listRoutings(),
    ]);

    const routingsByDept = new Map<string, DepartmentCaseRouting[]>();
    for (const r of routings) {
      const list = routingsByDept.get(r.departmentId) ?? [];
      list.push(r);
      routingsByDept.set(r.departmentId, list);
    }

    return departments.map((d) => ({
      ...d,
      cases: routingsByDept.get(d.id) ?? [],
    }));
  }
}
