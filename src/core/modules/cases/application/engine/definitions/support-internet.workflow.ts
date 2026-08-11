import type { CaseContext } from "../../../domain/contexts/case-context";
import type { SupportInternetContext } from "../../../domain/contexts/support-internet.context";
import { resetWaitingAttempts } from "../../../domain/contexts/engine-meta";
import type { WorkflowDefinition, WorkflowStateHandler } from "../workflow-definition";

/**
 * docs/spec/02_STATE_MACHINE.md §3 + §13 — SUPPORT_INTERNET con WaitingSteps.
 */

type ValidateClientContractResult = {
  id: string;
  name: string;
  address?: string;
  status?: string;
  router: { sector: string; olt_name: string; pon: string; serial: string };
};

type ValidateClientOutput = {
  found: boolean;
  contractNumbers: number;
  contracts: ValidateClientContractResult[];
};

type CheckBalanceOutput = {
  hasDebt: boolean;
  debt?: number;
};

type DiagnosticOutput = {
  status: "WAITING_USER" | "COMPLETED" | "ESCALATED";
  question?: string;
  diagnostic?: string;
};

/**
 * Normaliza el result de DIAGNOSTIC/CONTINUE_DIAGNOSTIC al contrato de la API
 * (docs/spec/04_N8N_WORKFLOW_SPEC.md §11). Cubre el wrap correcto de n8n y, como
 * red de seguridad, la forma cruda del microservicio MikroTik
 * (`workflow.status` + `instruction`).
 */
export function normalizeDiagnosticResult(raw: Record<string, unknown>): DiagnosticOutput {
  const direct = typeof raw.status === "string" ? raw.status.toUpperCase() : "";
  if (direct === "WAITING_USER" || direct === "COMPLETED" || direct === "ESCALATED") {
    const question = typeof raw.question === "string" ? raw.question : undefined;
    const diagnostic =
      typeof raw.diagnostic === "string"
        ? raw.diagnostic
        : typeof (raw.diagnostic as { status?: unknown } | undefined)?.status === "string"
          ? String((raw.diagnostic as { status: string }).status)
          : undefined;
    return {
      status: direct,
      ...(question ? { question } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }

  const workflow = (raw.workflow ?? {}) as { status?: unknown; currentStep?: unknown };
  const workflowStatus = typeof workflow.status === "string" ? workflow.status.toLowerCase() : "";
  const instruction =
    typeof raw.instruction === "string"
      ? raw.instruction.trim()
      : typeof raw.question === "string"
        ? raw.question.trim()
        : "";

  const diagObj = raw.diagnostic as
    | { status?: string; findings?: Array<{ type?: string }> }
    | string
    | undefined;
  const diagnosticLabel =
    typeof diagObj === "string"
      ? diagObj
      : diagObj?.findings?.[0]?.type || diagObj?.status || (typeof workflow.currentStep === "string" ? workflow.currentStep : undefined);

  let status: DiagnosticOutput["status"];
  if (workflowStatus === "waiting_user" || workflowStatus === "waiting") {
    status = "WAITING_USER";
  } else if (["completed", "complete", "resolved", "done"].includes(workflowStatus)) {
    status = "COMPLETED";
  } else if (["escalated", "failed", "error", "unresolvable"].includes(workflowStatus)) {
    status = "ESCALATED";
  } else if (instruction) {
    status = "WAITING_USER";
  } else {
    status = "ESCALATED";
  }

  return {
    status,
    ...(status === "WAITING_USER" && instruction ? { question: instruction } : {}),
    ...(diagnosticLabel ? { diagnostic: diagnosticLabel } : {}),
  };
}

function requireSupportInternetContext(context: CaseContext): SupportInternetContext {
  if (context.workflowType !== "SUPPORT_INTERNET") {
    throw new Error(`Contexto invalido para SUPPORT_INTERNET: workflowType='${context.workflowType}'`);
  }
  return context.data;
}

function withContext(data: SupportInternetContext, base?: CaseContext): CaseContext {
  return {
    workflowType: "SUPPORT_INTERNET",
    data,
    _engine: base?._engine,
  };
}

const validateClient: WorkflowStateHandler = async ({
  caseId,
  conversationId,
  correlationId,
  context,
  gateway,
  entities,
  identity,
}) => {
  let data = requireSupportInternetContext(context);

  // §14: si esta conversación ya validó identidad, no pedir cédula ni llamar n8n.
  if (identity) {
    const reused = await identity.tryGetValidatedIdentity(conversationId);
    if (reused) {
      const nextData: SupportInternetContext = {
        ...data,
        pendingContracts: undefined,
        client: { nationalId: reused.nationalId, fullName: reused.fullName },
        contract: {
          id: reused.contract.id,
          sector: reused.contract.sector,
          oltName: reused.contract.oltName,
          pon: reused.contract.pon,
          serial: reused.contract.serial,
          ...(reused.contract.router ? { router: reused.contract.router } : {}),
        },
      };
      return { type: "CONTINUE", nextState: "CHECK_BALANCE", context: withContext(nextData, context) };
    }
  }

  // Fusionar entities del WaitingStep (nationalId) antes de llamar a n8n.
  const nationalIdFromEntities =
    typeof entities?.nationalId === "string" ? entities.nationalId.trim() : "";
  if (nationalIdFromEntities) {
    data = {
      ...data,
      client: {
        nationalId: nationalIdFromEntities,
        fullName: data.client?.fullName ?? "",
      },
    };
  }

  if (!data.client?.nationalId) {
    const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_CLIENT");
    return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context: waiting };
  }

  const result = await gateway.executeAction({
    action: "VALIDATE_CLIENT",
    caseId,
    conversationId,
    correlationId,
    input: { id: data.client.nationalId },
  });

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context: withContext(data, context) };
  }

  const output = result.result as ValidateClientOutput;

  if (!output.found || output.contracts.length === 0) {
    const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_CLIENT");
    return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context: waiting };
  }

  if (output.contracts.length > 1) {
    const pendingContracts = output.contracts.map((c) => ({
      id: c.id,
      name: c.name,
      address: c.address,
      sector: c.router.sector,
      oltName: c.router.olt_name,
      pon: c.router.pon,
      serial: c.router.serial,
    }));
    const nextData: SupportInternetContext = { ...data, pendingContracts };
    const waiting = resetWaitingAttempts(
      withContext(nextData, context),
      "WAITING_USER_DISAMBIGUATE",
    );
    return { type: "WAITING_USER", nextState: "WAITING_USER_DISAMBIGUATE", context: waiting };
  }

  const found = output.contracts[0]!;
  const nationalId = data.client.nationalId;
  const nextData: SupportInternetContext = {
    ...data,
    pendingContracts: undefined,
    client: { nationalId, fullName: found.name },
    contract: {
      id: found.id,
      sector: found.router.sector,
      oltName: found.router.olt_name,
      pon: found.router.pon,
      serial: found.router.serial,
    },
  };
  if (identity) {
    await identity.rememberValidatedIdentity({
      conversationId,
      nationalId,
      fullName: found.name,
      contract: {
        contractNumber: found.id,
        sector: found.router.sector,
        oltName: found.router.olt_name,
        pon: found.router.pon,
        serial: found.router.serial,
      },
    });
  }
  return { type: "CONTINUE", nextState: "CHECK_BALANCE", context: withContext(nextData, context) };
};

const disambiguateContract: WorkflowStateHandler = async ({
  conversationId,
  context,
  entities,
  identity,
}) => {
  const data = requireSupportInternetContext(context);
  const pending = data.pendingContracts ?? [];
  if (pending.length === 0) {
    return {
      type: "ESCALATED",
      reason: "No hay contratos pendientes para desambiguar",
      context,
    };
  }

  const address =
    typeof entities?.address === "string" ? entities.address.trim().toLowerCase() : "";
  const fullName =
    typeof entities?.fullName === "string" ? entities.fullName.trim().toLowerCase() : "";

  const matched = pending.find((c) => {
    if (fullName && c.name.toLowerCase().includes(fullName)) return true;
    if (address && (c.address ?? "").toLowerCase().includes(address)) return true;
    return false;
  });

  if (!matched) {
    // Sin match: el evaluator §13 ya debio haber pedido reintento; si llegamos
    // aqui con entities incompletas, re-preguntar.
    const waiting = resetWaitingAttempts(context, "WAITING_USER_DISAMBIGUATE");
    return { type: "WAITING_USER", nextState: "WAITING_USER_DISAMBIGUATE", context: waiting };
  }

  const nationalId = data.client?.nationalId ?? matched.id;
  const nextData: SupportInternetContext = {
    ...data,
    pendingContracts: undefined,
    client: {
      nationalId,
      fullName: matched.name,
    },
    contract: {
      id: matched.id,
      sector: matched.sector,
      oltName: matched.oltName,
      pon: matched.pon,
      serial: matched.serial,
    },
  };
  if (identity && data.client?.nationalId) {
    await identity.rememberValidatedIdentity({
      conversationId,
      nationalId: data.client.nationalId,
      fullName: matched.name,
      contract: {
        contractNumber: matched.id,
        sector: matched.sector,
        oltName: matched.oltName,
        pon: matched.pon,
        serial: matched.serial,
      },
    });
  }
  return { type: "CONTINUE", nextState: "CHECK_BALANCE", context: withContext(nextData, context) };
};

const checkBalance: WorkflowStateHandler = async ({ caseId, conversationId, correlationId, context, gateway }) => {
  const data = requireSupportInternetContext(context);

  const result = await gateway.executeAction({
    action: "CHECK_BALANCE",
    caseId,
    conversationId,
    correlationId,
    input: { id: data.client?.nationalId ?? null },
  });

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context };
  }

  const output = result.result as CheckBalanceOutput;
  const nextData: SupportInternetContext = {
    ...data,
    balance: { hasDebt: output.hasDebt, amount: output.debt },
  };

  if (output.hasDebt) {
    return { type: "CONTINUE", nextState: "RESPOND_DEBT", context: withContext(nextData, context) };
  }
  return { type: "CONTINUE", nextState: "DIAGNOSTIC", context: withContext(nextData, context) };
};

const respondDebt: WorkflowStateHandler = async ({ context }) => {
  return { type: "COMPLETED", context };
};

const diagnostic: WorkflowStateHandler = async ({
  caseId,
  conversationId,
  correlationId,
  currentState,
  context,
  gateway,
  text,
  entities,
}) => {
  const data = requireSupportInternetContext(context);
  const isContinuation = currentState === "WAITING_USER_DIAGNOSTIC";
  const action = isContinuation ? "CONTINUE_DIAGNOSTIC" : "DIAGNOSTIC";

  const answerFromEntities =
    typeof entities?.answer === "string" ? entities.answer.trim() : "";
  const message = isContinuation ? answerFromEntities || text || "" : undefined;

  const input = isContinuation
    ? { conversationId, message: message ?? "" }
    : {
        sector: data.contract?.sector ?? null,
        oltName: data.contract?.oltName ?? null,
        pon: data.contract?.pon ?? null,
        serial: data.contract?.serial ?? null,
        conversationId,
      };

  const result = await gateway.executeAction({
    action,
    caseId,
    conversationId,
    correlationId,
    input,
  });

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context };
  }

  const output = normalizeDiagnosticResult(
    (result.result ?? {}) as Record<string, unknown>,
  );

  if (output.status === "WAITING_USER") {
    const nextData: SupportInternetContext = {
      ...data,
      diagnostic: { status: "PENDING", lastQuestion: output.question },
    };
    const waiting = resetWaitingAttempts(
      withContext(nextData, context),
      "WAITING_USER_DIAGNOSTIC",
    );
    return { type: "WAITING_USER", nextState: "WAITING_USER_DIAGNOSTIC", context: waiting };
  }

  if (output.status === "COMPLETED") {
    const nextData: SupportInternetContext = {
      ...data,
      diagnostic: { status: "RESOLVED", result: output.diagnostic },
    };
    return { type: "COMPLETED", context: withContext(nextData, context) };
  }

  const nextData: SupportInternetContext = {
    ...data,
    diagnostic: { status: "UNRESOLVABLE", result: output.diagnostic },
  };
  return {
    type: "ESCALATED",
    reason: "Diagnostico no resoluble automaticamente",
    context: withContext(nextData, context),
  };
};

export const supportInternetWorkflow: WorkflowDefinition = {
  workflowType: "SUPPORT_INTERNET",
  initialState: "VALIDATE_CLIENT",
  expirationHours: 24,
  waitingSteps: {
    WAITING_USER_CLIENT: {
      pendingQuestion: "Para ayudarte con tu servicio de internet, ¿me confirmas tu número de cédula?",
      requireAll: ["nationalId"],
      maxAttempts: 2,
    },
    WAITING_USER_DISAMBIGUATE: {
      pendingQuestion:
        "Encontré más de un contrato a tu nombre, ¿me confirmas tu dirección o el nombre completo del titular?",
      requireAny: ["address", "fullName"],
      maxAttempts: 2,
    },
    WAITING_USER_DIAGNOSTIC: {
      pendingQuestion: "{{question}}",
      requireAll: ["answer"],
      maxAttempts: 2,
    },
  },
  replyTemplates: {
    WAITING_USER_CLIENT:
      "Para ayudarte con tu servicio de internet, ¿me confirmas tu número de cédula?",
    WAITING_USER_DISAMBIGUATE:
      "Encontré más de un contrato a tu nombre, ¿me confirmas tu dirección o el nombre completo del titular?",
    WAITING_USER_DIAGNOSTIC: "{{question}}",
    RESPOND_DEBT:
      "Detectamos un saldo pendiente de {{debt}} en tu cuenta. Cuando regularices el pago podemos continuar con el soporte técnico.",
    COMPLETED:
      "Listo: revisamos tu conexión. {{diagnostic}} Si el problema continúa, escríbenos de nuevo.",
    ESCALATED:
      "Escalamos tu caso a un asesor de soporte. En breve te contactarán para ayudarte.",
    ACTIVE: "Seguimos trabajando en tu caso de internet. Un momento por favor.",
  },
  states: {
    VALIDATE_CLIENT: validateClient,
    WAITING_USER_CLIENT: validateClient,
    WAITING_USER_DISAMBIGUATE: disambiguateContract,
    CHECK_BALANCE: checkBalance,
    RESPOND_DEBT: respondDebt,
    DIAGNOSTIC: diagnostic,
    WAITING_USER_DIAGNOSTIC: diagnostic,
  },
};
