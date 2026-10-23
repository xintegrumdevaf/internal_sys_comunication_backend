import type { Department } from "../../domain/department.entity";
import type { DepartmentCaseRouting } from "../../domain/department-case-routing.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";

export type DepartmentWithCases = Department & {
  cases: DepartmentCaseRouting[];
  activeCases: number;
  active_cases: number;
  casesCount: number;
};

export class ListDepartmentsUseCase {
  constructor(private readonly departmentRepo: DepartmentRepositoryPort) {}

  async execute(): Promise<DepartmentWithCases[]> {
    const [departments, routings, activeCasesMap] = await Promise.all([
      this.departmentRepo.list(),
      this.departmentRepo.listRoutings(),
      this.departmentRepo.countActiveCasesByDepartment(),
    ]);

    const routingsByDept = new Map<string, DepartmentCaseRouting[]>();
    for (const r of routings) {
      const list = routingsByDept.get(r.departmentId) ?? [];
      list.push(r);
      routingsByDept.set(r.departmentId, list);
    }

    return departments.map((d) => {
      const activeCases = activeCasesMap[d.id] ?? 0;
      return {
        ...d,
        cases: routingsByDept.get(d.id) ?? [],
        activeCases,
        active_cases: activeCases,
        casesCount: activeCases,
      };
    });
  }
}
