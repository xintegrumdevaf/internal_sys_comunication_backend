import type { DepartmentRepositoryPort } from "../ports/department.repository.port";
import type { DepartmentCaseRouting } from "../../domain/department-case-routing.entity";
import type { Logger } from "../../../../../shared/logging/logger";
import { mapIntentToWorkflowType } from "../../../cases/domain/intent-catalog";
import { resolveGeneralDepartment } from "./general-department.helper";

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
    const normalizedKey = intentKey.toLowerCase();
    const exact = this.cache.find((r) => r.intentKey.toLowerCase() === normalizedKey);
    if (exact) return exact;

    if (
      normalizedKey === "support.service_cancellation" ||
      normalizedKey === "support.equipment_return"
    ) {
      const semanticMatch = this.findCancellationOrReturnRouting(normalizedKey);
      if (semanticMatch) return semanticMatch;
    }

    const catalogWorkflow = mapIntentToWorkflowType(intentKey);

    // Fallback por prefijo solo cuando el intent pertenece a un workflow automatizado conocido
    // (evita que intents sin workflow como support.equipment_return caigan en support.internet).
    if (catalogWorkflow) {
      const prefix = intentKey.split(".")[0]?.toLowerCase();
      if (prefix) {
        const byPrefix = this.cache.find((r) => {
          if (!r.intentKey.toLowerCase().startsWith(`${prefix}.`)) return false;
          if (r.workflowType.toUpperCase() !== catalogWorkflow.toUpperCase()) {
            const isSalesFamily =
              prefix === "sales" &&
              (r.workflowType === "SALES" ||
                r.workflowType === "GENERAL_INQUIRY" ||
                r.workflowType === "SALES_PACKAGES");
            if (!isSalesFamily) return false;
          }
          return true;
        });
        if (byPrefix) return byPrefix;
      }
    }

    return null;
  }

  private findCancellationOrReturnRouting(normalizedKey: string): DepartmentCaseRouting | null {
    const strip = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const isEquipmentIntent = normalizedKey === "support.equipment_return";
    const primaryKeywords = isEquipmentIntent
      ? ["devoluci", "retiro", "retirar", "retiren", "equipo", "router", "ruter", "modem", "baja"]
      : ["retiro", "retirar", "baja", "cancelaci", "rescisi", "anular", "dar de baja"];

    let best: { routing: DepartmentCaseRouting; score: number } | null = null;

    for (const r of this.cache) {
      const key = strip(r.intentKey);
      const label = strip(r.label);
      const desc = strip(r.description);

      let score = 0;
      for (const kw of primaryKeywords) {
        if (label.includes(kw)) score += 6;
        if (key.includes(kw)) score += 5;
        if (desc.includes(kw)) score += 2;
      }

      if (score === 0) continue;

      // Penalizar motivos secundarios (ej. "Última factura posterior a retiro") frente al motivo principal ("Retiro")
      if (label.includes("posterior") || label.includes("ultima factura")) {
        score -= 5;
      }
      if (/^(retiro|cancelacion|baja|devolucion)/.test(label)) {
        score += 6;
      }
      if (r.handlingMode === "human_direct") {
        score += 1;
      }

      if (!best || score > best.score) {
        best = { routing: r, score };
      }
    }

    return best && best.score > 0 ? best.routing : null;
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
      HOME_RELOCATION: ["traslados", "traslado", "soporte", "support", "atencion"],
      BILLING_BALANCE: ["cartera", "billing", "facturacion", "cobros", "pagos", "cuentas"],
      SUPPORT_INTERNET: ["support", "soporte", "soporte-tecnico", "tecnico", "averias"],
      SALES: ["sales", "ventas", "comercial", "planes"],
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
        HOME_RELOCATION: ["traslado", "traslados", "mudanza", "soporte", "support"],
        BILLING_BALANCE: ["cartera", "factura", "cobro", "pago", "billing", "saldo", "deuda"],
        SUPPORT_INTERNET: ["soporte", "tecnico", "support", "internet", "averia"],
        SALES: ["venta", "comercial", "sales", "plan"],
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

      // 4. Fallback universal a General: los casos no clasificados caen a General cuando exista.
      const generalDept = await resolveGeneralDepartment(this.departmentRepo);
      return generalDept?.id ?? null;
    } catch {
      // Ignorar error de lista si ocurre en fakes incompletos
    }

    const generalDept = await resolveGeneralDepartment(this.departmentRepo);
    return generalDept?.id ?? null;
  }

  getDepartmentSlug(departmentId: string): string | null {
    return this.departmentSlugMap.get(departmentId) ?? null;
  }
}
