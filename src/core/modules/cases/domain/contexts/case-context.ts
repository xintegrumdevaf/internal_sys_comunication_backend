import type { SupportInternetContext } from "./support-internet.context";
import type { BillingBalanceContext } from "./billing-balance.context";
import type { SalesPackagesContext } from "./sales-packages.context";
import type { GeneralInquiryContext } from "./general-inquiry.context";
import type { CaseEngineMeta } from "./engine-meta";

export type CaseCloseReason = "RESOLVED" | "CLIENT_NO_RESPONSE";

export type CaseScheduleTag = "AGENDADO" | "POSPUESTO" | "MONITOREO" | (string & {});

export type CaseSchedulingMetadata = {
  scheduledAt: string;
  scheduleTag: CaseScheduleTag;
  reminderReason?: string | null;
  scheduledByAgentId: string;
  notifiedAt: string | null;
};

type ContextCommon = {
  closeReason?: CaseCloseReason;
  schedulingMetadata?: CaseSchedulingMetadata;
  _engine?: CaseEngineMeta;
};

/**
 * docs/spec/01_DATA_MODEL.md §4 — `case.context` tipado por workflow_type.
 * `_engine` es metadata del motor (§13), no dato de negocio.
 */
export type CaseContext =
  | ({
      workflowType: "SUPPORT_INTERNET";
      data: SupportInternetContext;
    } & ContextCommon)
  | ({
      workflowType: "BILLING_BALANCE";
      data: BillingBalanceContext;
    } & ContextCommon)
  | ({
      workflowType: "SALES_PACKAGES";
      data: SalesPackagesContext;
    } & ContextCommon)
  | ({
      workflowType: "UNCLASSIFIED";
      data: Record<string, never>;
    } & ContextCommon)
  | ({
      workflowType: "GENERAL_INQUIRY";
      data: GeneralInquiryContext;
    } & ContextCommon);

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
