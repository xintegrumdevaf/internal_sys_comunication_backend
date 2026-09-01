import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";

/**
 * docs/spec/02_STATE_MACHINE.md §9 — tabla de mapeo `workflow_type -> department`,
 * configuracion (no keywords sobre el texto del mensaje). `null` deja el caso
 * sin departamento (pool de triage, §10) hasta que se reclasifique manualmente.
 */
const WORKFLOW_TYPE_TO_DEPARTMENT_SLUG: Readonly<Record<string, string>> = {
  SUPPORT_INTERNET: "support",
  BILLING_BALANCE: "billing",
  SALES_PACKAGES: "sales",
  GENERAL_INQUIRY: "general",
  sales: "sales",
  support: "support",
  billing: "billing",
  general: "general",
};

export class DepartmentResolverService {
  constructor(private readonly departmentRepo: DepartmentRepositoryPort) {}

  async resolveDepartmentId(workflowType: string): Promise<string | null> {
    const slug = WORKFLOW_TYPE_TO_DEPARTMENT_SLUG[workflowType];
    if (!slug) {
      return null;
    }
    const department = await this.departmentRepo.findBySlug(slug);
    return department?.id ?? null;
  }
}
