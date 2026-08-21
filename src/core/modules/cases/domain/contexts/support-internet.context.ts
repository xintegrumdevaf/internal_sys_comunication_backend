/**
 * docs/spec/01_DATA_MODEL.md §4 — contexto tipado de SUPPORT_INTERNET.
 * Los datos tecnicos del contrato (sector/oltName/pon/serial/router) SIEMPRE
 * se leen de aqui una vez resueltos (§5 de ese documento) — ninguna accion
 * hacia n8n se los pide al LLM.
 */
export type SupportInternetPendingContract = {
  id: string;
  name: string;
  address?: string;
  sector: string;
  oltName: string;
  pon: string;
  serial: string;
};

/**
 * Telemetria real de la ONU devuelta por el microservicio de diagnostico
 * (mikrotik_api → TechnicalDataResponseDTO), aplanada a nombres entendibles
 * para un agente no tecnico. Todo opcional: el microservicio puede no
 * alcanzar a leer algunos campos si la ONU esta caida.
 */
export type SupportInternetDiagnosticTechnical = {
  /** Marca del OLT que atiende la ONU (p.ej. "v-sol", "huawei"). */
  brand?: string;
  onuModel?: string;
  onuSerial?: string;
  macAddress?: string;
  /** Potencia optica recibida (RX) en dBm. Valores muy negativos = señal debil. */
  opticalPowerDbm?: number | null;
  /** Estado operativo reportado por el OLT (online/offline/dying-gasp, etc.). */
  runState?: string;
  adminState?: string;
  channel?: string;

  // Campos adicionales para no ocultar información técnica de la ONU/OLT
  onuIndex?: string;
  onuId?: number;
  onuProfile?: string;
  onuMode?: string;
  stateOnuIndex?: string;
  omccState?: string;
  phaseState?: string;
  onuNumber?: string;
};
// ... (rest of file)
export type SupportInternetContext = {
  client?: { nationalId: string; fullName: string };
  contract?: {
    id: string;
    sector: string;
    oltName: string;
    pon: string;
    serial: string;
    /** Modelo de router — el workflow real `find-client-contract` no lo devuelve hoy. */
    router?: string;
  };
  /** Contratos candidatos cuando VALIDATE_CLIENT devuelve mas de uno (§13 desambiguar). */
  pendingContracts?: SupportInternetPendingContract[];
  balance?: { hasDebt: boolean; amount?: number };
  diagnostic?: {
    status: string;
    lastQuestion?: string;
    result?: string;
    answer?: string;
    /** Ultima lectura tecnica conocida de la ONU (si el microservicio la devolvio). */
    technical?: SupportInternetDiagnosticTechnical;
  };
};

/**
 * Aplana el bloque `technical` crudo del microservicio de diagnostico
 * (mikrotik_api → TechnicalDataResponseDTO: brand/onu/state/power/mac) a
 * nombres entendibles para un agente no tecnico. La usan tanto el workflow
 * de SUPPORT_INTERNET (para persistirla en el context del case) como el
 * resumen de escalacion (docs/spec/03_API_CONTRACT.md §D) — una sola fuente
 * de verdad para no duplicar el mapeo (DRY).
 */
export function normalizeTechnicalData(raw: unknown): SupportInternetDiagnosticTechnical | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as {
    brand?: unknown;
    onu?: {
      onuindex?: unknown;
      id?: unknown;
      model?: unknown;
      profile?: unknown;
      mode?: unknown;
      serial?: unknown;
      authinfo?: unknown;
    } | null;
    state?: {
      onuIndex?: unknown;
      adminState?: unknown;
      omccState?: unknown;
      phaseState?: unknown;
      channel?: unknown;
      onuNumber?: unknown;
      runState?: unknown;
    } | null;
    power?: unknown;
    mac?: { mac?: unknown } | string | null;
  };

  const result: SupportInternetDiagnosticTechnical = {
    ...(typeof t.brand === "string" ? { brand: t.brand } : {}),
    ...(typeof t.onu?.model === "string" ? { onuModel: t.onu.model } : {}),
    ...(typeof t.onu?.serial === "string"
      ? { onuSerial: t.onu.serial }
      : typeof t.onu?.authinfo === "string"
        ? { onuSerial: t.onu.authinfo }
        : {}),
    ...(typeof t.mac === "string"
      ? { macAddress: t.mac }
      : typeof t.mac?.mac === "string"
        ? { macAddress: t.mac.mac }
        : {}),
    ...(typeof t.power === "number" ? { opticalPowerDbm: t.power } : {}),
    ...(typeof t.state?.runState === "string" ? { runState: t.state.runState } : {}),
    ...(typeof t.state?.adminState === "string" ? { adminState: t.state.adminState } : {}),
    ...(typeof t.state?.channel === "string" ? { channel: t.state.channel } : {}),

    // Mapeo de nuevos campos técnicos solicitados
    ...(typeof t.onu?.onuindex === "string" ? { onuIndex: t.onu.onuindex } : {}),
    ...(typeof t.onu?.id === "number" ? { onuId: t.onu.id } : {}),
    ...(typeof t.onu?.profile === "string" ? { onuProfile: t.onu.profile } : {}),
    ...(typeof t.onu?.mode === "string" ? { onuMode: t.onu.mode } : {}),
    ...(typeof t.state?.onuIndex === "string" ? { stateOnuIndex: t.state.onuIndex } : {}),
    ...(typeof t.state?.omccState === "string" ? { omccState: t.state.omccState } : {}),
    ...(typeof t.state?.phaseState === "string" ? { phaseState: t.state.phaseState } : {}),
    ...(typeof t.state?.onuNumber === "string" ? { onuNumber: t.state.onuNumber } : {}),
  };

  return Object.keys(result).length > 0 ? result : undefined;
}
