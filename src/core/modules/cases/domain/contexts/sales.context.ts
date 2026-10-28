/**
 * docs/spec/01_DATA_MODEL.md §4 — Contexto tipado del flujo comercial SALES.
 */
export interface SalesCoverage {
  hasCoverage: boolean;
  zoneName?: string;
  city?: string;
  matchType?: "exact_coordinates" | "text_sector_match" | "none";
  addressProvided?: string;
  reason?: string;
}

export type SalesContext = {
  /** sales / plans = consulta de planes o contratación; upgrade = cambio de plan. */
  purpose?: "sales" | "plans" | "packages" | "upgrade";
  requestedSpeed?: string;
  currentPlan?: { name: string; speed: string };
  offer?: { planId: string; name?: string; price: number; speed?: string; answer?: string };
  address?: string;
  mapLocation?: string;
  coordinates?: { lat: number; lng: number };
  coverage?: SalesCoverage;
};

// Compatibilidad hacia atrás
export type SalesPackagesContext = SalesContext;
export type SalesPackagesCoverage = SalesCoverage;
