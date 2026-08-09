import type { CaseContext } from "../../domain/contexts/case-context";
import type { WorkflowDefinition, WorkflowStepOutcome } from "../engine/workflow-definition";

const CLARIFY_TEMPLATE =
  "No estoy seguro de cómo ayudarte. ¿Es un problema de internet, de facturación/pagos, o quieres hablar con un asesor?";

const REQUEST_HUMAN_TEMPLATE =
  "Te conectamos con un asesor humano. En breve te atenderán por este mismo chat.";

/**
 * Formatea montos para plantillas/compose (ej. 45.5 → "45.50").
 */
export function formatDebtAmount(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n.toFixed(2);
  }
  return null;
}

/**
 * Resuelve la plantilla de negocio (02_STATE_MACHINE.md §12) a partir del
 * outcome del motor o de una decision de arbitraje (CLARIFY / REQUEST_HUMAN).
 */
export function resolveReplyTemplate(input: {
  definition?: WorkflowDefinition | null;
  outcome?: WorkflowStepOutcome;
  decision?: "CLARIFY" | "REQUEST_HUMAN";
  context?: CaseContext;
}): { templateHint: string; resultVars: Record<string, unknown>; action: string; status: string; missingFields?: string[] } {
  if (input.decision === "CLARIFY") {
    return {
      templateHint: CLARIFY_TEMPLATE,
      resultVars: {},
      action: "CLARIFY",
      status: "CLARIFY",
    };
  }
  if (input.decision === "REQUEST_HUMAN") {
    return {
      templateHint: REQUEST_HUMAN_TEMPLATE,
      resultVars: {},
      action: "REQUEST_HUMAN",
      status: "REQUEST_HUMAN",
    };
  }

  const outcome = input.outcome;
  const templates = input.definition?.replyTemplates ?? {};
  const contextData =
    input.context && "data" in input.context
      ? (input.context.data as Record<string, unknown>)
      : {};

  if (!outcome) {
    return {
      templateHint: templates.ACTIVE ?? "Estamos procesando tu solicitud.",
      resultVars: flattenContext(contextData),
      action: "UNKNOWN",
      status: "ACTIVE",
    };
  }

  if (outcome.type === "WAITING_USER") {
    const diagnostic = (contextData.diagnostic ?? {}) as Record<string, unknown>;
    const question =
      typeof diagnostic.lastQuestion === "string" ? diagnostic.lastQuestion : "";
    const waitingDecl = input.definition?.waitingSteps?.[outcome.nextState];
    const missingFields = input.context?._engine?.missingFields;
    let templateHint =
      waitingDecl?.pendingQuestion ??
      templates[outcome.nextState] ??
      templates.WAITING_USER_CLIENT ??
      CLARIFY_TEMPLATE;
    if (missingFields && missingFields.length > 0) {
      templateHint = `No pude obtener ${missingFields.join(" y ")}. ${templateHint}`;
    }
    return {
      templateHint,
      resultVars: { ...flattenContext(contextData), question },
      action: outcome.nextState,
      status: "WAITING_USER",
      missingFields,
    };
  }

  if (outcome.type === "COMPLETED") {
    const balance = (contextData.balance ?? {}) as Record<string, unknown>;
    // Cierre por deuda (RESPOND_DEBT): no usar plantilla de diagnostico.
    if (balance.hasDebt === true) {
      return debtReply(templates, contextData, balance, "COMPLETED");
    }
    const diagnostic = (contextData.diagnostic ?? {}) as Record<string, unknown>;
    return {
      templateHint: templates.COMPLETED ?? "Tu solicitud fue atendida.",
      resultVars: {
        ...flattenContext(contextData),
        diagnostic: diagnostic.result ?? "",
      },
      action: "COMPLETED",
      status: "COMPLETED",
    };
  }

  if (outcome.type === "ESCALATED") {
    return {
      templateHint: templates.ESCALATED ?? REQUEST_HUMAN_TEMPLATE,
      resultVars: flattenContext(contextData),
      action: "ESCALATED",
      status: "ESCALATED",
    };
  }

  // CONTINUE leftover / ACTIVE
  const balance = (contextData.balance ?? {}) as Record<string, unknown>;
  if (balance.hasDebt === true || outcome.nextState === "RESPOND_DEBT") {
    return debtReply(templates, contextData, balance, "ACTIVE");
  }

  return {
    templateHint: templates.ACTIVE ?? "Seguimos con tu caso.",
    resultVars: flattenContext(contextData),
    action: outcome.nextState,
    status: "ACTIVE",
  };
}

function debtReply(
  templates: Record<string, string>,
  contextData: Record<string, unknown>,
  balance: Record<string, unknown>,
  status: string,
): { templateHint: string; resultVars: Record<string, unknown>; action: string; status: string } {
  const debtFormatted = formatDebtAmount(balance.amount) ?? formatDebtAmount(balance.debt);
  const debtValue = debtFormatted ?? "";
  return {
    templateHint:
      templates.RESPOND_DEBT ??
      "Detectamos un saldo pendiente de {{debt}} en tu cuenta. Cuando regularices el pago podemos continuar con el soporte técnico.",
    resultVars: {
      ...flattenContext(contextData),
      hasDebt: true,
      debt: debtValue,
      amount: balance.amount ?? balance.debt,
    },
    action: "RESPOND_DEBT",
    status,
  };
}

function flattenContext(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        out[innerKey] = innerValue;
        out[`${key}.${innerKey}`] = innerValue;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}
