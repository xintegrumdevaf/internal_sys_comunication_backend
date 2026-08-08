import type { CaseContext } from "../../../domain/contexts/case-context";
import type { SupportInternetContext } from "../../../domain/contexts/support-internet.context";
import type { WorkflowDefinition, WorkflowStateHandler, WorkflowStepInput } from "../workflow-definition";

/**
 * docs/spec/02_STATE_MACHINE.md §3 — flujo de referencia:
 *
 *   VALIDATE_CLIENT --cliente validado--> CHECK_BALANCE
 *   VALIDATE_CLIENT --faltan datos--> WAITING_USER_CLIENT --usuario responde--> VALIDATE_CLIENT
 *   CHECK_BALANCE --tiene deuda--> RESPOND_DEBT --> COMPLETED
 *   CHECK_BALANCE --sin deuda--> DIAGNOSTIC
 *   DIAGNOSTIC --necesita info--> WAITING_USER_DIAGNOSTIC --usuario responde--> DIAGNOSTIC (nunca vuelve a VALIDATE_CLIENT/CHECK_BALANCE)
 *   DIAGNOSTIC --resuelto--> COMPLETED
 *   DIAGNOSTIC --no resoluble--> ESCALATED
 *
 * WAITING_USER_CLIENT/WAITING_USER_DIAGNOSTIC reusan el handler del estado
 * "activo" correspondiente: retomar nunca reinicia el workflow (regla dura
 * de docs/spec/02_STATE_MACHINE.md §2), simplemente se re-ejecuta el mismo
 * paso con el contexto ya actualizado por la respuesta del usuario.
 */

// Formas de `result` esperadas de cada accion de n8n (docs/spec/04_N8N_WORKFLOW_SPEC.md §6).
// Se afinan con datos reales en la Etapa 4; aqui documentan el contrato asumido.
type ValidateClientOutput = {
  needsInput?: boolean;
  client?: SupportInternetContext["client"];
  contract?: SupportInternetContext["contract"];
};

type CheckBalanceOutput = {
  hasDebt: boolean;
  amount?: number;
};

type DiagnosticOutput = {
  resolved?: boolean;
  unresolvable?: boolean;
  question?: string;
  result?: string;
};

function requireSupportInternetContext(context: CaseContext): SupportInternetContext {
  if (context.workflowType !== "SUPPORT_INTERNET") {
    throw new Error(`Contexto invalido para SUPPORT_INTERNET: workflowType='${context.workflowType}'`);
  }
  return context.data;
}

function withContext(data: SupportInternetContext): CaseContext {
  return { workflowType: "SUPPORT_INTERNET", data };
}

const validateClient: WorkflowStateHandler = async ({ caseId, conversationId, correlationId, context, gateway }) => {
  const data = requireSupportInternetContext(context);

  const result = await gateway.executeAction({
    action: "VALIDATE_CLIENT",
    caseId,
    conversationId,
    correlationId,
    input: { nationalId: data.client?.nationalId ?? null },
  });

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context };
  }

  const output = result.result as ValidateClientOutput;
  if (output.needsInput) {
    return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context };
  }

  const nextData: SupportInternetContext = {
    ...data,
    client: output.client ?? data.client,
    contract: output.contract ?? data.contract,
  };
  return { type: "CONTINUE", nextState: "CHECK_BALANCE", context: withContext(nextData) };
};

const checkBalance: WorkflowStateHandler = async ({ caseId, conversationId, correlationId, context, gateway }) => {
  const data = requireSupportInternetContext(context);

  const result = await gateway.executeAction({
    action: "CHECK_BALANCE",
    caseId,
    conversationId,
    correlationId,
    input: { nationalId: data.client?.nationalId ?? null },
  });

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context };
  }

  const output = result.result as CheckBalanceOutput;
  const nextData: SupportInternetContext = {
    ...data,
    balance: { hasDebt: output.hasDebt, amount: output.amount },
  };

  if (output.hasDebt) {
    return { type: "CONTINUE", nextState: "RESPOND_DEBT", context: withContext(nextData) };
  }
  return { type: "CONTINUE", nextState: "DIAGNOSTIC", context: withContext(nextData) };
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
}) => {
  const data = requireSupportInternetContext(context);
  const action = currentState === "WAITING_USER_DIAGNOSTIC" ? "CONTINUE_DIAGNOSTIC" : "DIAGNOSTIC";

  const result = await gateway.executeAction({
    action,
    caseId,
    conversationId,
    correlationId,
    input: {
      sector: data.contract?.sector ?? null,
      oltName: data.contract?.oltName ?? null,
      pon: data.contract?.pon ?? null,
      serial: data.contract?.serial ?? null,
    },
  });

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context };
  }

  const output = result.result as DiagnosticOutput;
  const nextData: SupportInternetContext = {
    ...data,
    diagnostic: {
      status: output.resolved ? "RESOLVED" : output.unresolvable ? "UNRESOLVABLE" : "PENDING",
      lastQuestion: output.question,
      result: output.result,
    },
  };

  if (output.resolved) {
    return { type: "COMPLETED", context: withContext(nextData) };
  }
  if (output.unresolvable) {
    return {
      type: "ESCALATED",
      reason: "Diagnostico no resoluble automaticamente",
      context: withContext(nextData),
    };
  }
  return { type: "WAITING_USER", nextState: "WAITING_USER_DIAGNOSTIC", context: withContext(nextData) };
};

export const supportInternetWorkflow: WorkflowDefinition = {
  workflowType: "SUPPORT_INTERNET",
  initialState: "VALIDATE_CLIENT",
  expirationHours: 24,
  states: {
    VALIDATE_CLIENT: validateClient,
    WAITING_USER_CLIENT: validateClient,
    CHECK_BALANCE: checkBalance,
    RESPOND_DEBT: respondDebt,
    DIAGNOSTIC: diagnostic,
    WAITING_USER_DIAGNOSTIC: diagnostic,
  },
};

export type { WorkflowStepInput as SupportInternetStepInput };
