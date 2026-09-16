import type { DepartmentRepositoryPort } from "../ports/department.repository.port";
import type { DepartmentCaseRouting } from "../../domain/department-case-routing.entity";
import type { Logger } from "../../../../../shared/logging/logger";

export interface DynamicPromptIntent {
  intent: string;
  label: string;
  description: string;
  handlingMode: "ai_assisted" | "human_direct";
  workflowType: string;
  departmentId: string;
}

export class DepartmentRoutingService {
  private cache: DepartmentCaseRouting[] = [];
  private departmentSlugMap = new Map<string, string>(); // departmentId -> slug
  private isLoaded = false;

  constructor(
    private readonly departmentRepo: DepartmentRepositoryPort,
    private readonly logger: Logger,
  ) {}

  async loadCache(): Promise<void> {
    try {
      const [routings, departments] = await Promise.all([
        this.departmentRepo.listRoutings(),
        this.departmentRepo.list(),
      ]);

      this.cache = routings.filter((r) => r.active);
      this.departmentSlugMap.clear();
      for (const d of departments) {
        this.departmentSlugMap.set(d.id, d.slug);
      }

      this.isLoaded = true;
      this.logger.debug(
        { activeRoutingsCount: this.cache.length, departmentsCount: departments.length },
        "Caché de enrutamiento dinámico de departamentos cargado",
      );
    } catch (err) {
      this.logger.error({ err }, "Error al cargar caché de enrutamiento de departamentos");
    }
  }

  async invalidateCache(): Promise<void> {
    await this.loadCache();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.isLoaded) {
      await this.loadCache();
    }
  }

  async getPromptIntents(): Promise<DynamicPromptIntent[]> {
    await this.ensureLoaded();
    return this.cache.map((r) => ({
      intent: r.intentKey,
      label: r.label,
      description: r.description,
      handlingMode: r.handlingMode,
      workflowType: r.workflowType,
      departmentId: r.departmentId,
    }));
  }

  async resolveByIntent(intentKey: string): Promise<DepartmentCaseRouting | null> {
    await this.ensureLoaded();
    const exact = this.cache.find((r) => r.intentKey.toLowerCase() === intentKey.toLowerCase());
    if (exact) return exact;

    // Fallback por prefijo: ej. support.xxx -> match primer support.*
    const prefix = intentKey.split(".")[0]?.toLowerCase();
    if (prefix) {
      const byPrefix = this.cache.find((r) => r.intentKey.toLowerCase().startsWith(`${prefix}.`));
      if (byPrefix) return byPrefix;
    }

    return null;
  }

  async resolveDepartmentId(workflowType: string): Promise<string | null> {
    await this.ensureLoaded();

    // 1. Buscar en tabla de enrutamiento dinámica por workflow_type
    const matchedRouting = this.cache.find(
      (r) => r.workflowType.toUpperCase() === workflowType.toUpperCase(),
    );
    if (matchedRouting) {
      return matchedRouting.departmentId;
    }

    // 2. Fallback por lista de candidatos de slugs comunes por tipo de flujo
    const candidateSlugsMap: Record<string, string[]> = {
      BILLING_BALANCE: ["cartera", "billing", "facturacion", "cobros", "pagos", "cuentas"],
      SUPPORT_INTERNET: ["support", "soporte", "soporte-tecnico", "tecnico", "averias"],
      SALES_PACKAGES: ["sales", "ventas", "comercial", "planes"],
      GENERAL_INQUIRY: ["general", "atencion", "atencion-al-cliente", "recepcion"],
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
      for (const targetSlug of candidateSlugs) {
        const dept = await this.departmentRepo.findBySlug(targetSlug);
        if (dept && dept.active !== false) {
          return dept.id;
        }
      }
    }

    // 3. Fallback por coincidencia de palabras clave en el slug o nombre de departamentos activos
    try {
      const allDepts = await this.departmentRepo.list();
      const activeDepts = allDepts.filter((d) => d.active !== false);

      const keywordsMap: Record<string, string[]> = {
        BILLING_BALANCE: ["cartera", "factura", "cobro", "pago", "billing", "saldo", "deuda"],
        SUPPORT_INTERNET: ["soporte", "tecnico", "support", "internet", "averia"],
        SALES_PACKAGES: ["venta", "comercial", "sales", "plan"],
        GENERAL_INQUIRY: ["general", "atencion", "recepcion"],
      };

      const keywords =
        keywordsMap[workflowType.toUpperCase()] ?? keywordsMap[workflowType];

      if (keywords && activeDepts.length > 0) {
        const matched = activeDepts.find((d) => {
          const normSlug = d.slug.toLowerCase();
          const normName = d.name.toLowerCase();
          return keywords.some((kw) => normSlug.includes(kw) || normName.includes(kw));
        });
        if (matched) {
          return matched.id;
        }
      }

      if (activeDepts.length > 0) {
        return activeDepts[0]!.id;
      }
    } catch {
      // Ignorar error de lista si ocurre en fakes incompletos
    }

    return null;
  }

  getDepartmentSlug(departmentId: string): string | null {
    return this.departmentSlugMap.get(departmentId) ?? null;
  }
}
