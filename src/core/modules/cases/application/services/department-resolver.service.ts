import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { DepartmentRoutingService } from "../../../departments/application/services/department-routing.service";

/**
 * docs/spec/02_STATE_MACHINE.md §9 — resolución de departamento para casos.
 * Consulta primero el catálogo dinámico de enrutamiento (DepartmentRoutingService)
 * con fallback a los slugs estándar conocidos si no hubiera servicio inyectado.
 */
export class DepartmentResolverService {
  constructor(
    private readonly departmentRepo: DepartmentRepositoryPort,
    private readonly routingService?: DepartmentRoutingService,
  ) {}

  async resolveDepartmentId(workflowType: string, intent?: string): Promise<string | null> {
    if (this.routingService) {
      if (intent) {
        const byIntent = await this.routingService.resolveByIntent(intent);
        if (byIntent) {
          return byIntent.departmentId;
        }
      }
      return this.routingService.resolveDepartmentId(workflowType);
    }

    const standardSlugMap: Record<string, string> = {
      SUPPORT_INTERNET: "support",
      BILLING_BALANCE: "billing",
      SALES_PACKAGES: "sales",
      GENERAL_INQUIRY: "general",
      support: "support",
      billing: "billing",
      sales: "sales",
      general: "general",
    };

    const slug = standardSlugMap[workflowType];
    if (!slug) {
      return null;
    }
    const department = await this.departmentRepo.findBySlug(slug);
    return department?.id ?? null;
  }
}
