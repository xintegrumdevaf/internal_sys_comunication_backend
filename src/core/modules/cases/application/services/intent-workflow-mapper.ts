/**
 * `Interpretation.intent` (docs/spec/03_API_CONTRACT.md §A) llega como string
 * jerarquico ('support.internet', 'billing.record_payment', ...). Este mapeo
 * es configuracion, no un `if`/keyword sobre el texto crudo del mensaje —
 * consistente con docs/spec/02_STATE_MACHINE.md §9.
 */
const INTENT_PREFIX_TO_WORKFLOW_TYPE: Readonly<Record<string, string>> = {
  support: "SUPPORT_INTERNET",
  billing: "BILLING_BALANCE",
  sales: "SALES_PACKAGES",
};

export function mapIntentToWorkflowType(intent: string): string | null {
  const prefix = intent.split(".")[0] ?? "";
  return INTENT_PREFIX_TO_WORKFLOW_TYPE[prefix] ?? null;
}
