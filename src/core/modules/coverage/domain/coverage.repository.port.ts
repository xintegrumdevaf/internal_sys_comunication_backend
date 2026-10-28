import type { CoverageZone } from "./coverage-zone.entity";

export interface CoverageRepositoryPort {
  /** Reemplaza atómicamente todas las zonas activas dentro de una transacción. */
  replaceAll(zones: CoverageZone[]): Promise<void>;

  /** Obtiene todas las zonas marcadas como activas. */
  findAllActive(): Promise<CoverageZone[]>;

  /** Conteo de zonas activas almacenadas. */
  count(): Promise<number>;
}
