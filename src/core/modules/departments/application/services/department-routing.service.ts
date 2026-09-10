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

    // 2. Fallback estándar por slug conocido de departamento
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

    const targetSlug = standardSlugMap[workflowType];
    if (targetSlug) {
      const dept = await this.departmentRepo.findBySlug(targetSlug);
      return dept?.id ?? null;
    }

    return null;
  }

  getDepartmentSlug(departmentId: string): string | null {
    return this.departmentSlugMap.get(departmentId) ?? null;
  }
}
