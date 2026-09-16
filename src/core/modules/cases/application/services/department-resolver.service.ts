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

    const candidateSlugsMap: Record<string, string[]> = {
      BILLING_BALANCE: ["cartera", "billing", "facturacion", "cobros", "pagos"],
      SUPPORT_INTERNET: ["support", "soporte", "soporte-tecnico", "tecnico"],
      SALES_PACKAGES: ["sales", "ventas", "comercial"],
      GENERAL_INQUIRY: ["general", "atencion", "atencion-al-cliente"],
      billing: ["cartera", "billing", "facturacion", "cobros", "pagos"],
      support: ["support", "soporte", "soporte-tecnico", "tecnico"],
      sales: ["sales", "ventas", "comercial"],
      general: ["general", "atencion", "atencion-al-cliente"],
    };

    const candidateSlugs =
      candidateSlugsMap[workflowType.toUpperCase()] ??
      candidateSlugsMap[workflowType] ??
      candidateSlugsMap[workflowType.toLowerCase()];

    if (candidateSlugs) {
      for (const slug of candidateSlugs) {
        const department = await this.departmentRepo.findBySlug(slug);
        if (department) {
          return department.id;
        }
      }
    }

    try {
      const allDepts = await this.departmentRepo.list();
      const activeDepts = allDepts.filter((d) => d.active !== false);
      if (activeDepts.length > 0) {
        return activeDepts[0]!.id;
      }
    } catch {
      // Ignorar
    }

    return null;
  }

  getDepartmentSlug(departmentId: string): string | null {
    return this.routingService?.getDepartmentSlug(departmentId) ?? null;
  }
}
