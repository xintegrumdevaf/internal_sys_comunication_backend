import type { CaseContext } from "../../domain/contexts/case-context";
import type { WorkflowDefinition, WorkflowStepOutcome } from "../engine/workflow-definition";

const CLARIFY_TEMPLATE =
  "¡Hola! 👋 ¿En qué te puedo ayudar hoy? ¿Tienes algún inconveniente con tu internet, pagos, o prefieres hablar con un especialista?";

const REQUEST_HUMAN_TEMPLATE =
  "Te conectamos con un especialista humano. En breve te atenderán por este mismo chat.";

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
    const friendlyMissingFields = missingFields?.map(f => {
      if (f === "nationalId") return "tu número de cédula";
      if (f === "address") return "tu dirección";
      if (f === "fullName") return "el nombre completo del titular";
      if (f === "answer") return "una respuesta clara";
      return f;
    });

    if (friendlyMissingFields && friendlyMissingFields.length > 0) {
      templateHint = `Aún me falta ${friendlyMissingFields.join(" y ")}. ${templateHint}`;
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
    return resolveCompleted(templates, contextData);
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
  if (
    outcome.nextState === "RESPOND_NO_DEBT" ||
    outcome.nextState === "RESPOND_DEBT_WITH_OPTIONS" ||
    (templates.RESPOND_NO_DEBT && balance.hasDebt === false) ||
    (templates.RESPOND_DEBT_WITH_OPTIONS && balance.hasDebt === true)
  ) {
    return billingBalanceReply(templates, contextData, balance, "ACTIVE", outcome.nextState);
  }
  if (balance.hasDebt === true || outcome.nextState === "RESPOND_DEBT") {
    return debtReply(templates, contextData, balance, "ACTIVE");
  }
  if (outcome.nextState === "RESPOND_OFFER") {
    const offer = (contextData.offer ?? {}) as Record<string, unknown>;
    return {
      templateHint: templates[outcome.nextState] ?? templates.ACTIVE ?? "Seguimos con tu caso.",
      resultVars: {
        ...flattenContext(contextData),
        offerAnswer: offer.answer ?? "",
      },
      action: outcome.nextState,
      status: "ACTIVE",
    };
  }

  return {
    templateHint: templates.ACTIVE ?? "Seguimos con tu caso.",
    resultVars: flattenContext(contextData),
    action: outcome.nextState,
    status: "ACTIVE",
  };
}

function resolveCompleted(
  templates: Record<string, string>,
  contextData: Record<string, unknown>,
): { templateHint: string; resultVars: Record<string, unknown>; action: string; status: string } {
  const balance = (contextData.balance ?? {}) as Record<string, unknown>;
  const payment = (contextData.payment ?? {}) as Record<string, unknown>;
  const offer = (contextData.offer ?? {}) as Record<string, unknown>;
  const flat = flattenContext(contextData);

  if (payment.status === "RECORDED") {
    const amount = formatDebtAmount(payment.amount) ?? "";
    return {
      templateHint:
        templates.COMPLETED ??
        "Registramos tu pago de {{debt}} con referencia {{reference}}. Gracias.",
      resultVars: {
        ...flat,
        debt: amount,
        reference: payment.reference ?? "",
        paymentMessage: amount
          ? `Registramos tu pago de $${amount} (ref. ${String(payment.reference ?? "")}).`
          : "Registramos tu pago.",
      },
      action: "RECORD_PAYMENT",
      status: "COMPLETED",
    };
  }

  // BILLING consulta de saldo (§15): dos plantillas distintas según hasDebt.
  if (
    (templates.RESPOND_NO_DEBT || templates.RESPOND_DEBT_WITH_OPTIONS) &&
    balance.hasDebt !== undefined
  ) {
    return billingBalanceReply(templates, contextData, balance, "COMPLETED");
  }

  // SUPPORT cierre por deuda.
  if (balance.hasDebt === true && templates.RESPOND_DEBT) {
    return debtReply(templates, contextData, balance, "COMPLETED");
  }

  return {
    templateHint: templates.COMPLETED ?? "Tu solicitud fue atendida.",
    resultVars: {
      ...flat,
      diagnostic:
        typeof (contextData.diagnostic as { result?: string } | undefined)?.result === "string"
          ? (contextData.diagnostic as { result: string }).result
          : "",
      offerAnswer: typeof offer.answer === "string" ? offer.answer : "",
      paymentMessage: "",
    },
    action: "COMPLETED",
    status: "COMPLETED",
  };
}

function billingBalanceReply(
  templates: Record<string, string>,
  contextData: Record<string, unknown>,
  balance: Record<string, unknown>,
  status: string,
  nextState?: string,
): { templateHint: string; resultVars: Record<string, unknown>; action: string; status: string } {
  const hasDebt = balance.hasDebt === true || nextState === "RESPOND_DEBT_WITH_OPTIONS";
  const debtFormatted = formatDebtAmount(balance.amount) ?? formatDebtAmount(balance.debt);
  const debtValue = debtFormatted ?? (hasDebt ? "" : "0.00");
  const flat = flattenContext(contextData);

  if (!hasDebt) {
    return {
      templateHint:
        templates.RESPOND_NO_DEBT ??
        "Revisé tu cuenta y no tienes ningún saldo pendiente en este momento.",
      resultVars: {
        ...flat,
        hasDebt: false,
        debt: debtValue,
        amount: balance.amount ?? balance.debt ?? 0,
      },
      action: "RESPOND_NO_DEBT",
      status,
    };
  }

  return {
    templateHint:
      templates.RESPOND_DEBT_WITH_OPTIONS ??
      "Revisé tu cuenta y encontré un saldo pendiente de ${{debt}}. Si ya realizaste el pago, envíame la foto del comprobante y lo registro; si no, cuéntame si necesitas ayuda con las formas de pago disponibles.",
    resultVars: {
      ...flat,
      hasDebt: true,
      debt: debtValue,
      amount: balance.amount ?? balance.debt,
    },
    action: "RESPOND_DEBT_WITH_OPTIONS",
    status,
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
