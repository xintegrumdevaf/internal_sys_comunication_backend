import type { SupportInternetContext } from "./support-internet.context";
import type { BillingBalanceContext } from "./billing-balance.context";
import type { SalesPackagesContext } from "./sales-packages.context";
import type { CaseEngineMeta } from "./engine-meta";

/**
 * docs/spec/01_DATA_MODEL.md §4 — `case.context` tipado por workflow_type.
 * `_engine` es metadata del motor (§13), no dato de negocio.
 */
export type CaseContext =
  | {
      workflowType: "SUPPORT_INTERNET";
      data: SupportInternetContext;
      _engine?: CaseEngineMeta;
    }
  | {
      workflowType: "BILLING_BALANCE";
      data: BillingBalanceContext;
      _engine?: CaseEngineMeta;
    }
  | {
      workflowType: "SALES_PACKAGES";
      data: SalesPackagesContext;
      _engine?: CaseEngineMeta;
    }
  | {
      workflowType: "UNCLASSIFIED";
      data: Record<string, never>;
      _engine?: CaseEngineMeta;
    }
  | {
      workflowType: "GENERAL_INQUIRY";
      data: { question?: string };
      _engine?: CaseEngineMeta;
    };

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
    case "GENERAL_INQUIRY":
      return { workflowType, data: {} };
  }
}
