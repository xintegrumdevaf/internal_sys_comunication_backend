import type { SupportInternetContext } from "./support-internet.context";
import type { BillingBalanceContext } from "./billing-balance.context";
import type { SalesPackagesContext } from "./sales-packages.context";

/**
 * docs/spec/01_DATA_MODEL.md §4 — `case.context` es JSONB en la base, pero la
 * capa de aplicacion nunca lo trata como `Record<string, unknown>` generico:
 * cada `workflow_type` tiene su propio tipo, discriminado por esta union.
 *
 * `UNCLASSIFIED` cubre el pool de triage (docs/spec/02_STATE_MACHINE.md §10):
 * intencion no clasificable, sin workflow ni departamento resuelto todavia.
 */
export type CaseContext =
  | { workflowType: "SUPPORT_INTERNET"; data: SupportInternetContext }
  | { workflowType: "BILLING_BALANCE"; data: BillingBalanceContext }
  | { workflowType: "SALES_PACKAGES"; data: SalesPackagesContext }
  | { workflowType: "UNCLASSIFIED"; data: Record<string, never> };

export function emptyContextFor(workflowType: CaseContext["workflowType"]): CaseContext {
  switch (workflowType) {
    case "SUPPORT_INTERNET":
      return { workflowType, data: {} };
    case "BILLING_BALANCE":
      return { workflowType, data: {} };
    case "SALES_PACKAGES":
      return { workflowType, data: {} };
    case "UNCLASSIFIED":
      return { workflowType, data: {} };
  }
}
