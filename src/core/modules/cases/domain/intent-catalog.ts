/**
 * Catálogo canónico de intents (docs/spec/06_AI_PROMPTS.md §2).
 * Una sola fuente de verdad para prompt + arbitraje.
 */
export const INTENT_CATALOG = [
  {
    intent: "support.internet",
    workflowType: "SUPPORT_INTERNET",
    description: "no tiene servicio de internet / está caído",
  },
  {
    intent: "support.slow_internet",
    workflowType: "SUPPORT_INTERNET",
    description: "internet lento (a futuro, workflow propio)",
  },
  {
    intent: "billing.balance",
    workflowType: "BILLING_BALANCE",
    description: "quiere saber cuánto debe / su saldo",
  },
  {
    intent: "billing.record_payment",
    workflowType: "BILLING_BALANCE",
    description: "envía o menciona un comprobante de pago",
  },
  {
    intent: "sales.packages",
    workflowType: "SALES_PACKAGES",
    description: "pregunta por planes/paquetes/precios/velocidades",
  },
  {
    intent: "sales.upgrade",
    workflowType: "SALES_PACKAGES",
    description: "quiere cambiar/mejorar su plan actual",
  },
  {
    intent: "general.inquiry",
    workflowType: "GENERAL_INQUIRY",
    description: "pregunta general de la empresa que no encaja arriba",
  },
  {
    intent: "unknown",
    workflowType: null,
    description: "no se puede determinar",
  },
] as const;

export type CatalogIntent = (typeof INTENT_CATALOG)[number]["intent"];

export function mapIntentToWorkflowType(intent: string): string | null {
  const exact = INTENT_CATALOG.find((row) => row.intent === intent);
  if (exact) return exact.workflowType;
  // Prefijo (compat): support.* → SUPPORT_INTERNET
  const prefix = intent.split(".")[0] ?? "";
  const byPrefix = INTENT_CATALOG.find((row) => row.intent.startsWith(`${prefix}.`));
  return byPrefix?.workflowType ?? null;
}

export function intentListForPrompt(): string {
  return INTENT_CATALOG.map((row) => row.intent).join(" | ");
}
