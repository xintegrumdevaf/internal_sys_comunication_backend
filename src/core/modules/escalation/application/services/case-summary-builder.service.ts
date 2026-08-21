import type { Case } from "../../../cases/domain/case.entity";
import { normalizeTechnicalData } from "../../../cases/domain/contexts/support-internet.context";
import type { WorkflowExecution } from "../../../cases/domain/workflow-execution.entity";
import type { EscalationSummary } from "../../domain/escalation.entity";

export type WorkflowEventSnapshot = {
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
};

/**
 * Construye el resumen estructurado de escalación de forma determinista
 * (docs/spec/03_API_CONTRACT.md §D) — nunca lo inventa el LLM.
 */
export class CaseSummaryBuilderService {
  build(input: {
    caseEntity: Case;
    reason: string;
    executions: WorkflowExecution[];
    events?: WorkflowEventSnapshot[];
    departmentSlug?: string | null;
  }): EscalationSummary {
    const { caseEntity, reason, executions, events = [], departmentSlug = null } = input;

    const completedSteps = executions
      .filter((e) => e.status === "COMPLETED")
      .map((e) => e.action);

    const results: Record<string, unknown> = {};

    for (const execution of executions) {
      if (execution.status === "COMPLETED" && execution.output) {
        Object.assign(results, execution.output);
      }
    }

    if (caseEntity.context && typeof caseEntity.context === "object") {
      const ctx = ((caseEntity.context as Record<string, unknown>).data ?? caseEntity.context) as Record<string, unknown>;
      if (ctx.client) results.client = ctx.client;
      if (ctx.contract) results.contract = ctx.contract;
      if (ctx.balance) {
        results.balance = ctx.balance;
        const bal = ctx.balance as { hasDebt?: boolean; amount?: number; debt?: number; status?: string };
        const hasDebt = Boolean(bal?.hasDebt || (bal?.amount ?? 0) > 0 || (bal?.debt ?? 0) > 0 || bal?.status === "DEBT");
        results.hasDebt = hasDebt;
        if (hasDebt) {
          results.debt = bal.amount ?? bal.debt;
        }
      }
      if (ctx.diagnostic && typeof ctx.diagnostic === "object") {
        const diag = ctx.diagnostic as Record<string, unknown>;
        if (diag.result || diag.status) {
          results.diagnostic = diag.result || diag.status;
        }
        if (diag.technical && !results.technical) {
          results.technical = diag.technical;
        }
      }
    }

    if ("technical" in results && results.technical) {
      const technical = normalizeTechnicalData(results.technical);
      if (technical) {
        results.technical = technical;
      } else {
        delete results.technical;
      }
    }

    const timeline: EscalationSummary["timeline"] = [
      ...executions.map((e) => ({
        action: e.action,
        status: e.status,
        at: (e.completedAt ?? e.startedAt).toISOString(),
      })),
      ...events
        .filter((ev) => ev.type === "CASE_ESCALATED" || ev.type === "WAITING_USER")
        .map((ev) => ({
          action: ev.type === "CASE_ESCALATED" ? "ESCALATE" : ev.type,
          status: "COMPLETED",
          at: ev.occurredAt.toISOString(),
        })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    const problem =
      typeof results.problem === "string"
        ? results.problem
        : describeProblem(caseEntity.workflowType, reason, results);

    return {
      problem,
      workflow: caseEntity.workflowType === "UNCLASSIFIED" ? null : caseEntity.workflowType,
      department: departmentSlug,
      status: caseEntity.status,
      reason,
      completedSteps,
      results: stripInternalKeys(results),
      pendingAction: "Intervención humana",
      timeline,
    };
  }
}

function describeProblem(workflowType: string, reason?: string, results?: Record<string, unknown>): string {
  const reasonLower = (reason ?? "").toLowerCase();
  if (
    reasonLower.includes("comprobante") ||
    reasonLower.includes("recibo") ||
    reasonLower.includes("pago") ||
    results?.receiptAttached
  ) {
    return "Validación de comprobante de pago de saldo pendiente";
  }

  switch (workflowType) {
    case "SUPPORT_INTERNET":
      return "Cliente reporta problema de internet";
    case "BILLING_BALANCE":
      return "Cliente consulta o gestiona facturación";
    case "SALES_PACKAGES":
      return "Cliente consulta paquetes / ventas";
    case "UNCLASSIFIED":
      return "Solicitud sin clasificar (triage)";
    default:
      return "Solicitud que requiere atención humana";
  }
}

function stripInternalKeys(results: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(results)) {
    if (key === "stack" || key === "raw" || key === "debug") continue;
    out[key] = value;
  }
  return out;
}
