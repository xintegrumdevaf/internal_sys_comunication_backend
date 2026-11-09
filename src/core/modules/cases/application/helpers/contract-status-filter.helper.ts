/**
 * Helper para clasificación, filtrado y priorización de contratos por estado de servicio.
 *
 * Jerarquía de Confianza:
 * 1. Estrictamente Activo ('ACTIVO', 'ACTIVE'): Máxima prioridad. Si existen contratos activos,
 *    se descartan automáticamente contratos anulados, retirados, rechazados o inactivos.
 * 2. Suspendido / Cortado ('CORTADO', 'SUSPENDIDO'): Clientes con mora o suspensión temporal
 *    que mantienen equipo y relación de servicio.
 * 3. Inactivos / Terminados ('ANULADO', 'RETIRADO', 'RECHAZADO', 'INACTIVO', 'BAJA'):
 *    Servicios dados de baja o cancelados definitivamente. No deben presentarse como
 *    servicios activos ni forzar desambiguaciones innecesarias a los clientes.
 */

export const INACTIVE_CONTRACT_STATUSES = new Set([
  "anulado",
  "retirado",
  "rechazado",
  "inactivo",
  "inactive",
  "cancelado",
  "cancelled",
  "baja",
  "eliminado",
]);

export const STRICTLY_ACTIVE_CONTRACT_STATUSES = new Set([
  "activo",
  "active",
]);

export const SUSPENDED_CONTRACT_STATUSES = new Set([
  "cortado",
  "suspendido",
  "suspension",
  "mora",
]);

export function normalizeContractStatus(status?: string | null): string {
  if (!status) return "";
  return status
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function isContractStrictlyActive(status?: string | null): boolean {
  return STRICTLY_ACTIVE_CONTRACT_STATUSES.has(normalizeContractStatus(status));
}

export function isContractInactive(status?: string | null): boolean {
  return INACTIVE_CONTRACT_STATUSES.has(normalizeContractStatus(status));
}

export function isContractSuspended(status?: string | null): boolean {
  return SUSPENDED_CONTRACT_STATUSES.has(normalizeContractStatus(status));
}

export type FilteredContractsResult<T> = {
  /** Contratos priorizados según la jerarquía de confianza activa */
  contracts: T[];
  /** Cantidad de contratos descartados por ser inactivos/anulados/retirados */
  excludedInactiveCount: number;
  /** Verdadero si se encontraron contratos estrictamente activos */
  hasStrictlyActive: boolean;
  /** Verdadero si todos los contratos encontrados estaban anulados o retirados */
  allContractsInactive: boolean;
};

/**
 * Filtra y prioriza una lista de contratos candidatos recibidos desde el ISP / n8n / Sheets.
 *
 * - Si existen contratos 'ACTIVO', retorna ÚNICAMENTE los contratos activos, descartando
 *   cualquier contrato 'ANULADO', 'RETIRADO' o inactivo.
 * - Si no hay contratos activos pero sí 'CORTADO', retorna los contratos cortados/suspendidos.
 * - Si todos los contratos figuran como 'ANULADO' o 'RETIRADO', retorna lista vacía y marca
 *   `allContractsInactive: true` para informar pedagógicamente al cliente en lugar de asumir
 *   un servicio activo inexistente.
 */
export function filterAndPrioritizeContracts<T extends { status?: string | null }>(
  rawContracts: T[],
): FilteredContractsResult<T> {
  if (!rawContracts || rawContracts.length === 0) {
    return {
      contracts: [],
      excludedInactiveCount: 0,
      hasStrictlyActive: false,
      allContractsInactive: false,
    };
  }

  const strictlyActive: T[] = [];
  const suspendedOrCut: T[] = [];
  const inactive: T[] = [];
  const unspecifiedOrOther: T[] = [];

  for (const c of rawContracts) {
    const st = normalizeContractStatus(c.status);
    if (!st) {
      unspecifiedOrOther.push(c);
    } else if (isContractStrictlyActive(st)) {
      strictlyActive.push(c);
    } else if (isContractInactive(st)) {
      inactive.push(c);
    } else if (isContractSuspended(st)) {
      suspendedOrCut.push(c);
    } else {
      unspecifiedOrOther.push(c);
    }
  }

  // Caso 1: Todos los contratos del cliente están anulados/retirados/inactivos
  if (
    inactive.length > 0 &&
    strictlyActive.length === 0 &&
    suspendedOrCut.length === 0 &&
    unspecifiedOrOther.length === 0
  ) {
    return {
      contracts: [],
      excludedInactiveCount: inactive.length,
      hasStrictlyActive: false,
      allContractsInactive: true,
    };
  }

  // Caso 2 (Nivel 1 de Confianza): Si hay contratos estrictamente ACTIVOS, se usan SOLO esos
  if (strictlyActive.length > 0) {
    return {
      contracts: strictlyActive,
      excludedInactiveCount: inactive.length,
      hasStrictlyActive: true,
      allContractsInactive: false,
    };
  }

  // Caso 3 (Nivel 2 de Confianza): Si no hay activos pero sí CORTADOS (mora), se usan esos
  if (suspendedOrCut.length > 0) {
    return {
      contracts: suspendedOrCut,
      excludedInactiveCount: inactive.length,
      hasStrictlyActive: false,
      allContractsInactive: false,
    };
  }

  // Caso 4: Contratos sin estado explícito o con otros estados operativos (descartando los inactivos)
  const nonInactive = rawContracts.filter(
    (c) => !isContractInactive(normalizeContractStatus(c.status)),
  );

  return {
    contracts: nonInactive,
    excludedInactiveCount: inactive.length,
    hasStrictlyActive: false,
    allContractsInactive: nonInactive.length === 0,
  };
}

