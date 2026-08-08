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

// Formas de `result` confirmadas contra los workflows reales de n8n
// (docs/spec/04_N8N_WORKFLOW_SPEC.md §11 — fixtures de prueba por accion).
//
// Anti-Corruption Layer (01_DATA_MODEL.md §5, docs/skills/design-patterns-backend.md):
// `find-client-contract` devuelve los datos tecnicos anidados bajo
// `contracts[].router.{sector, olt_name, pon, serial}` (snake_case) y puede
// devolver mas de un contrato — el handler `validateClient` de abajo es quien
// traduce esa forma externa al `SupportInternetContext.contract` interno
// (camelCase), nunca el dominio trabaja con la forma cruda de n8n.
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
  /** Codigo de diagnostico final cuando `status === "COMPLETED"` (ej. "ONU_UNREACHABLE"). */
  diagnostic?: string;
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

  // Campo real confirmado (04_N8N_WORKFLOW_SPEC.md §11): `id`, no `nationalId`.
  const result = await gateway.executeAction({
    action: "VALIDATE_CLIENT",
    caseId,
    conversationId,
    correlationId,
    input: { id: data.client?.nationalId ?? null },
  });

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context };
  }

  const output = result.result as ValidateClientOutput;

  if (!output.found || output.contracts.length === 0) {
    // No es un error de transporte (04_N8N_WORKFLOW_SPEC.md §11): re-pregunta
    // la cedula en vez de escalar directo a un humano por un posible typo.
    return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context };
  }

  // TODO(post-Etapa 4): multiples contratos requieren desambiguacion por
  // direccion/nombre (01_DATA_MODEL.md §5) — el flujo de conversacion todavia
  // no recolecta ese dato del cliente, asi que se escala en vez de adivinar
  // cual contrato es el correcto.
  if (output.contracts.length > 1) {
    return {
      type: "ESCALATED",
      reason: "Se encontro mas de un contrato para la cedula, requiere verificacion manual",
      context,
    };
  }

  const found = output.contracts[0]!;
  const nextData: SupportInternetContext = {
    ...data,
    client: { nationalId: found.id, fullName: found.name },
    contract: {
      id: found.id,
      sector: found.router.sector,
      oltName: found.router.olt_name,
      pon: found.router.pon,
      serial: found.router.serial,
    },
  };
  return { type: "CONTINUE", nextState: "CHECK_BALANCE", context: withContext(nextData) };
};

const checkBalance: WorkflowStateHandler = async ({ caseId, conversationId, correlationId, context, gateway }) => {
  const data = requireSupportInternetContext(context);

  // Campo real confirmado (04_N8N_WORKFLOW_SPEC.md §11): `id`, no `nationalId`.
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
  text,
}) => {
  const data = requireSupportInternetContext(context);
  const isContinuation = currentState === "WAITING_USER_DIAGNOSTIC";
  const action = isContinuation ? "CONTINUE_DIAGNOSTIC" : "DIAGNOSTIC";

  // Nombres de campo confirmados contra el workflow real de n8n
  // (docs/spec/04_N8N_WORKFLOW_SPEC.md §7.1/7.2) — snake_case hacia n8n
  // (`olt_name`, no `oltName`, aunque el dominio interno SI use camelCase,
  // ver 01_DATA_MODEL.md §4). CONTINUE_DIAGNOSTIC reenvia el mensaje crudo
  // del cliente tal cual, nunca una version reinterpretada por la IA.
  const input = isContinuation
    ? { conversationId, message: text ?? "" }
    : {
        sector: data.contract?.sector ?? null,
        olt_name: data.contract?.oltName ?? null,
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

  // Shape real confirmado (04_N8N_WORKFLOW_SPEC.md §11): `status` +
  // `question` (WAITING_USER) o `diagnostic` (COMPLETED) — no `resolved`/
  // `unresolvable`/`result` como se asumia antes de probar contra fixtures reales.
  const output = result.result as DiagnosticOutput;

  if (output.status === "WAITING_USER") {
    const nextData: SupportInternetContext = {
      ...data,
      diagnostic: { status: "PENDING", lastQuestion: output.question },
    };
    return { type: "WAITING_USER", nextState: "WAITING_USER_DIAGNOSTIC", context: withContext(nextData) };
  }

  if (output.status === "COMPLETED") {
    const nextData: SupportInternetContext = {
      ...data,
      diagnostic: { status: "RESOLVED", result: output.diagnostic },
    };
    return { type: "COMPLETED", context: withContext(nextData) };
  }

  // status === "ESCALATED" u otro valor no reconocido: nunca se deja el caso
  // sin ruta de salida (AGENTS.md — "todo error no recuperable tiene una ruta definida").
  const nextData: SupportInternetContext = {
    ...data,
    diagnostic: { status: "UNRESOLVABLE", result: output.diagnostic },
  };
  return {
    type: "ESCALATED",
    reason: "Diagnostico no resoluble automaticamente",
    context: withContext(nextData),
  };
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
