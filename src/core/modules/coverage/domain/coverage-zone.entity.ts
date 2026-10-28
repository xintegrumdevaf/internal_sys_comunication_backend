/** Coordenada geográfica perimetral [longitud, latitud]. Formato estándar GeoJSON. */
export type GeoCoordinate = [number, number];

/** Bounding Box para descarte rápido O(1) antes del cálculo perimetral. */
export interface GeoBoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** Entidad de Zona de Cobertura de red de fibra óptica. */
export interface CoverageZone {
  id?: string;
  name: string;
  folder?: string;
  city: string;
  coordinates: GeoCoordinate[];
  bbox: GeoBoundingBox;
  active: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Resultado de validación determinista de cobertura. */
export interface CoverageCheckResult {
  hasCoverage: boolean;
  zoneName?: string;
  city?: string;
  folder?: string;
  matchType?: "exact_coordinates" | "text_sector_match" | "none";
  reason?: string;
}
