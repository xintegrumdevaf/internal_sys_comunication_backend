/**
 * docs/spec/01_DATA_MODEL.md §4 — contexto tipado de SUPPORT_INTERNET.
 * Los datos tecnicos del contrato (sector/oltName/pon/serial/router) SIEMPRE
 * se leen de aqui una vez resueltos (§5 de ese documento) — ninguna accion
 * hacia n8n se los pide al LLM.
 */
export type SupportInternetContext = {
  client?: { nationalId: string; fullName: string };
  contract?: {
    id: string;
    sector: string;
    oltName: string;
    pon: string;
    serial: string;
    router: string;
  };
  balance?: { hasDebt: boolean; amount?: number };
  diagnostic?: { status: string; lastQuestion?: string; result?: string };
};
