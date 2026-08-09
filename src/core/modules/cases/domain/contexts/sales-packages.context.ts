/**
 * docs/spec/01_DATA_MODEL.md §4 — contexto tipado de SALES_PACKAGES (Etapa 8).
 */
export type SalesPackagesContext = {
  /** packages = consulta de planes; upgrade = quiere cambiar de plan. */
  purpose?: "packages" | "upgrade";
  requestedSpeed?: string;
  currentPlan?: { name: string; speed: string };
  offer?: { planId: string; name?: string; price: number; speed?: string; answer?: string };
};
