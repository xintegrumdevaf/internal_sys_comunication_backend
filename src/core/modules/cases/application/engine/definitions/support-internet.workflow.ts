import type { CaseContext } from "../../../domain/contexts/case-context";
import {
  normalizeTechnicalData,
  type SupportInternetContext,
  type SupportInternetDiagnosticTechnical,
} from "../../../domain/contexts/support-internet.context";
import { bumpWaitingAttempts, resetWaitingAttempts } from "../../../domain/contexts/engine-meta";
import { normalizeNationalId } from "../../../../customers/domain/national-id";
import type { WorkflowDefinition, WorkflowStateHandler } from "../workflow-definition";

/**
 * docs/spec/02_STATE_MACHINE.md §3 + §13 — SUPPORT_INTERNET con WaitingSteps.
 */

type ValidateClientContractResult = {
  id: string;
  name: string;
  address?: string;
  status?: string;
  ip?: string;
  router: { sector: string; olt_name: string; pon: string; serial: string; ip?: string };
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
  technical?: SupportInternetDiagnosticTechnical;
};

/**
 * Normaliza el result de DIAGNOSTIC/CONTINUE_DIAGNOSTIC al contrato de la API
 * (docs/spec/04_N8N_WORKFLOW_SPEC.md §11). Cubre el wrap correcto de n8n y, como
 * red de seguridad, la forma cruda del microservicio MikroTik
 * (`workflow.status` + `instruction`). En ambos casos, si viene `technical`
 * (telemetria real de la ONU), se conserva — es valioso para el agente aunque
 * el diagnostico automatico no haya podido resolverse solo.
 */
export function normalizeDiagnosticResult(raw: Record<string, unknown>): DiagnosticOutput {
  const technical = normalizeTechnicalData(raw.technical);

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
      ...(technical ? { technical } : {}),
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
  } else if (workflowStatus === "waiting_system" || workflowStatus === "recheck") {
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
    ...(technical ? { technical } : {}),
  };
}

function requireSupportInternetContext(context: CaseContext): SupportInternetContext {
  if (context?.workflowType && context.workflowType !== "SUPPORT_INTERNET") {
    throw new Error(`Contexto invalido para SUPPORT_INTERNET: workflowType='${context.workflowType}'`);
  }
  return context?.data ?? (context as unknown as SupportInternetContext) ?? {};
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

  // Si el caso ya tiene cliente y contrato resuelto previamente, no re-validar ni pedir cédula.
  if (data.client?.nationalId && data.contract?.id && (data.contract.sector || data.contract.oltName)) {
    return { type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS", context: withContext(data, context) };
  }

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
      return { type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS", context: withContext(nextData, context) };
    }
  }

  // Fusionar entities del WaitingStep (nationalId) antes de llamar a n8n.
  const rawNationalId =
    typeof entities?.nationalId === "string" ? entities.nationalId.trim() : "";
  const nationalIdFromEntities = normalizeNationalId(rawNationalId);
  if (nationalIdFromEntities) {
    data = {
      ...data,
      client: {
        nationalId: nationalIdFromEntities,
        fullName: data.client?.fullName ?? "",
      },
    };
  } else if (data.client?.nationalId) {
    data = {
      ...data,
      client: {
        ...data.client,
        nationalId: normalizeNationalId(data.client.nationalId),
      },
    };
  }

  const client = data.client;
  if (!client?.nationalId) {
    const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_CLIENT");
    return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context: waiting };
  }

  const result = await gateway.executeAction({
    action: "VALIDATE_CLIENT",
    caseId,
    conversationId,
    correlationId,
    input: { id: client.nationalId },
  });

  const isN8nNotFound =
    !result.success &&
    (result.error.type === "NOT_FOUND" ||
      result.error.message?.toLowerCase().includes("not found") ||
      result.error.message?.toLowerCase().includes("no se encontr"));

  if (isN8nNotFound) {
    const nextData: SupportInternetContext = {
      ...data,
      client: undefined,
      lastSearchedNationalId: client.nationalId,
      clientNotFound: true,
    };
    const waiting = bumpWaitingAttempts(withContext(nextData, context), ["nationalId"]);
    return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context: waiting };
  }

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context: withContext(data, context) };
  }

  const output = result.result as ValidateClientOutput;

  if (!output.found || output.contracts.length === 0) {
    const nextData: SupportInternetContext = {
      ...data,
      client: undefined,
      lastSearchedNationalId: client.nationalId,
      clientNotFound: true,
    };
    const waiting = bumpWaitingAttempts(withContext(nextData, context), ["nationalId"]);
    return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context: waiting };
  }

  // Si encontró, limpiamos flags de no encontrado
  data = {
    ...data,
    clientNotFound: false,
    lastSearchedNationalId: undefined,
  };

  if (output.contracts.length > 1) {
    const pendingContracts = output.contracts.map((c) => {
      const extra = c as unknown as { contractCode?: string; label?: string };
      return {
        id: c.id,
        contractCode: extra.contractCode,
        name: c.name,
        address: c.address,
        label: extra.label || c.address || `Contrato #${c.id}`,
        sector: c.router.sector,
        oltName: c.router.olt_name,
        pon: c.router.pon,
        serial: c.router.serial,
        ip: c.ip,
      };
    });
    const nextData: SupportInternetContext = { ...data, pendingContracts };
    const waiting = resetWaitingAttempts(
      withContext(nextData, context),
      "WAITING_USER_DISAMBIGUATE",
    );
    return { type: "WAITING_USER", nextState: "WAITING_USER_DISAMBIGUATE", context: waiting };
  }

  const found = output.contracts[0]!;
  const nationalId = client.nationalId;
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
      ip: found.ip ?? found.router.ip,
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
  return { type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS", context: withContext(nextData, context) };
};

const disambiguateContract: WorkflowStateHandler = async ({
  conversationId,
  context,
  text,
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

  let matched: (typeof pending)[number] | undefined;

  // 1. Coincidencia por número / opción ordinal (1, 2, 3...)
  const rawOption = entities?.selectedOption;
  let selectedIndex = -1;
  if (typeof rawOption === "number" && Number.isInteger(rawOption)) {
    selectedIndex = rawOption - 1;
  } else if (typeof rawOption === "string") {
    const parsed = parseInt(rawOption.trim(), 10);
    if (!Number.isNaN(parsed)) selectedIndex = parsed - 1;
  }

  if (selectedIndex < 0 && text) {
    const trimmed = text.trim().toLowerCase();
    const digitMatch = trimmed.match(/^(?:opci[oó]n|el|la|n[uú]mero|contrato)?\s*#?\s*([1-9]\d*)$/i);
    if (digitMatch && digitMatch[1]) {
      selectedIndex = parseInt(digitMatch[1], 10) - 1;
    } else if (trimmed === "primero" || trimmed === "primera" || trimmed === "el primero" || trimmed === "la primera") {
      selectedIndex = 0;
    } else if (trimmed === "segundo" || trimmed === "segunda" || trimmed === "el segundo" || trimmed === "la segunda") {
      selectedIndex = 1;
    } else if (trimmed === "tercero" || trimmed === "tercera" || trimmed === "el tercero" || trimmed === "la tercera") {
      selectedIndex = 2;
    }
  }

  if (selectedIndex >= 0 && selectedIndex < pending.length) {
    matched = pending[selectedIndex];
  }

  // 2. Coincidencia por código de contrato o id
  if (!matched) {
    const code =
      typeof entities?.contractCode === "string"
        ? entities.contractCode.trim().toLowerCase()
        : typeof entities?.contractId === "string"
          ? entities.contractId.trim().toLowerCase()
          : "";
    if (code) {
      matched = pending.find(
        (c) =>
          c.id.toLowerCase() === code ||
          (c.contractCode && c.contractCode.toLowerCase() === code) ||
          c.id.toLowerCase().includes(code),
      );
    }
  }

  // 3. Coincidencia por dirección o nombre
  if (!matched) {
    const address =
      typeof entities?.address === "string" ? entities.address.trim().toLowerCase() : "";
    const fullName =
      typeof entities?.fullName === "string" ? entities.fullName.trim().toLowerCase() : "";
    const rawText = (text || "").toLowerCase();

    matched = pending.find((c) => {
      if (fullName && c.name.toLowerCase().includes(fullName)) return true;
      if (address && (c.address ?? "").toLowerCase().includes(address)) return true;
      if (c.contractCode && rawText.includes(c.contractCode.toLowerCase())) return true;
      if (c.address && rawText.length >= 4 && c.address.toLowerCase().includes(rawText)) return true;
      return false;
    });
  }

  if (!matched) {
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
      ip: matched.ip,
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
  return { type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS", context: withContext(nextData, context) };
};

const checkClientStatus: WorkflowStateHandler = async ({
  caseId,
  conversationId,
  correlationId,
  context,
  gateway,
}) => {
  const data = requireSupportInternetContext(context);
  const sector = data.contract?.sector;
  const ip = data.contract?.ip;

  if (!sector || !ip) {
    return { type: "CONTINUE", nextState: "DIAGNOSTIC", context };
  }

  const result = await gateway.executeAction({
    action: "CHECK_CLIENT_STATUS",
    caseId,
    conversationId,
    correlationId,
    input: { sector, ip },
  });

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context };
  }

  const output = (result.result ?? {}) as {
    status?: string;
    list?: string;
    clientName?: string;
    creationTime?: string;
    canBeReactivated?: boolean;
    reason?: string;
  };

  const isCortado =
    output.status?.toUpperCase() === "CORTADO" ||
    output.list?.toUpperCase() === "CORTADO" ||
    /cortado/i.test(output.status ?? "") ||
    /cortado/i.test(output.list ?? "");

  const nextData: SupportInternetContext = {
    ...data,
    clientStatus: {
      sector,
      ip,
      status: output.status,
      clientName: output.clientName,
      list: output.list,
      creationTime: output.creationTime,
      canBeReactivated: output.canBeReactivated,
      reason: output.reason,
    },
  };

  if (isCortado) {
    return { type: "CONTINUE", nextState: "CHECK_BALANCE", context: withContext(nextData, context) };
  }

  return { type: "CONTINUE", nextState: "DIAGNOSTIC", context: withContext(nextData, context) };
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

/**
 * Detecta si una pregunta devuelta por el servicio de diagnóstico es idéntica
 * o semánticamente equivalente a una pregunta que el cliente ya respondió
 * (evitando bucles de preguntar repetidamente por las luces/router).
 */
function isSameOrRedundantQuestion(q1?: string, q2?: string): boolean {
  if (!q1 || !q2) return false;
  const clean = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  const c1 = clean(q1);
  const c2 = clean(q2);
  if (c1 === c2) return true;
  const isLightsQuestion = (c: string) =>
    (c.includes("luz") || c.includes("luces") || c.includes("color")) &&
    (c.includes("router") || c.includes("equipo") || c.includes("modem") || c.includes("onu") || c.includes("led"));
  if (isLightsQuestion(c1) && isLightsQuestion(c2)) {
    return true;
  }
  return false;
}

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

  const initialInput = {
    sector: data.contract?.sector ?? null,
    oltName: data.contract?.oltName ?? null,
    pon: data.contract?.pon ?? null,
    serial: data.contract?.serial ?? null,
    conversationId,
    ...(message ? { message } : {}),
  };

  const input = isContinuation
    ? { conversationId, message: message ?? "" }
    : initialInput;

  let result = await gateway.executeAction({
    action,
    caseId,
    conversationId,
    correlationId,
    input,
  });

  // Resiliencia ante fallos de CONTINUE_DIAGNOSTIC:
  // Si la sesión de continuación se perdió, expiró o falló,
  // volvemos a disparar el DIAGNOSTIC inicial con los datos del contrato conocidos.
  if (!result.success && isContinuation) {
    result = await gateway.executeAction({
      action: "DIAGNOSTIC",
      caseId,
      conversationId,
      correlationId,
      input: initialInput,
    });
  }

  // Si tras el fallback sigue fallando, escalamos inmediatamente a un humano.
  // NUNCA repetir la misma pregunta en bucle ni reintentar indefinidamente.
  if (!result.success) {
    const nextData: SupportInternetContext = {
      ...data,
      diagnostic: {
        status: "UNRESOLVABLE",
        result: result.error.message || "Falla en servicio de diagnóstico",
      },
    };
    return {
      type: "ESCALATED",
      reason: result.error.message || "El diagnóstico técnico no pudo continuar automáticamente; derivando a un asesor",
      context: withContext(nextData, context),
    };
  }

  const output = normalizeDiagnosticResult(
    (result.result ?? {}) as Record<string, unknown>,
  );

  const isEscalation =
    output.status === "ESCALATED" ||
    /revisi[oó]n t[eé]cnica|visita t[eé]cnica|especialista|t[eé]cnico|falla f[ií]sica|escal/i.test(
      output.question ?? output.diagnostic ?? "",
    );

  if (isEscalation) {
    const nextData: SupportInternetContext = {
      ...data,
      diagnostic: {
        status: "UNRESOLVABLE",
        result: output.diagnostic || output.question || "Falla física del equipo",
        lastQuestion: output.question,
        ...(output.technical ? { technical: output.technical } : {}),
      },
    };
    return {
      type: "ESCALATED",
      reason: output.question || output.diagnostic || "Diagnostico no resoluble automaticamente",
      context: withContext(nextData, context),
    };
  }

  if (output.status === "WAITING_USER") {
    // Si la pregunta devuelta es idéntica o redundante a la que el usuario acaba de responder,
    // o si el sistema entra en bucle de preguntas de luces, derivar de inmediato a un humano.
    if (isContinuation && isSameOrRedundantQuestion(output.question, data.diagnostic?.lastQuestion)) {
      const nextData: SupportInternetContext = {
        ...data,
        diagnostic: {
          status: "UNRESOLVABLE",
          result: "Diagnóstico técnico requiere asistencia personalizada",
          lastQuestion: output.question,
          ...(output.technical ? { technical: output.technical } : {}),
        },
      };
      return {
        type: "ESCALATED",
        reason: "El diagnóstico técnico repitió la misma pregunta; derivando a un asesor",
        context: withContext(nextData, context),
      };
    }

    const previousRounds = data.diagnostic?.rounds ?? 0;
    const currentRounds = isContinuation ? previousRounds + 1 : 1;

    // Máximo 2 rondas de preguntas técnicas automáticas antes de transferir a humano
    if (currentRounds > 2) {
      const nextData: SupportInternetContext = {
        ...data,
        diagnostic: {
          status: "UNRESOLVABLE",
          result: "Límite de preguntas de diagnóstico alcanzado",
          lastQuestion: output.question,
          rounds: currentRounds,
          ...(output.technical ? { technical: output.technical } : {}),
        },
      };
      return {
        type: "ESCALATED",
        reason: "Límite de preguntas de diagnóstico alcanzado; derivando a un asesor",
        context: withContext(nextData, context),
      };
    }

    const nextData: SupportInternetContext = {
      ...data,
      diagnostic: {
        status: "PENDING",
        lastQuestion: output.question,
        result: output.diagnostic,
        rounds: currentRounds,
        ...(output.technical ? { technical: output.technical } : {}),
      },
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
      diagnostic: {
        status: "RESOLVED",
        result: output.diagnostic,
        rounds: data.diagnostic?.rounds ?? 1,
        ...(output.technical ? { technical: output.technical } : {}),
      },
    };
    return { type: "COMPLETED", context: withContext(nextData, context) };
  }

  const nextData: SupportInternetContext = {
    ...data,
    diagnostic: {
      status: "UNRESOLVABLE",
      result: output.diagnostic,
      ...(output.technical ? { technical: output.technical } : {}),
    },
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
      pendingQuestion: "Para ayudarte con el servicio de internet, ¿me confirmas el número de cédula del titular del servicio?",
      requireAll: ["nationalId"],
      maxAttempts: 3,
    },
    WAITING_NATIONAL_ID: {
      pendingQuestion: "Para ayudarte con el servicio de internet, ¿me confirmas el número de cédula del titular del servicio?",
      requireAll: ["nationalId"],
      maxAttempts: 3,
    },
    WAITING_USER_DISAMBIGUATE: {
      pendingQuestion:
        "Encontré más de un contrato asociado a tu cédula. Por favor indícame con cuál de ellos tienes inconvenientes (puedes responder con el número de opción o la dirección):",
      requireAny: ["selectedOption", "contractCode", "address", "fullName"],
      maxAttempts: 3,
    },
    WAITING_USER_DIAGNOSTIC: {
      pendingQuestion: "{{question}}",
      requireAll: ["answer"],
      maxAttempts: 2,
    },
    WAITING_USER_PAYMENT: {
      pendingQuestion: "Detectamos un saldo pendiente en tu cuenta. Por favor envíanos el comprobante de pago para validar.",
      requireAny: ["receipt", "answer", "action"],
      maxAttempts: 2,
    },
  },
  replyTemplates: {
    WAITING_USER_CLIENT:
      "Para ayudarte con el servicio de internet, ¿me confirmas el número de cédula del titular del servicio?",
    WAITING_NATIONAL_ID:
      "Para ayudarte con el servicio de internet, ¿me confirmas el número de cédula del titular del servicio?",
    WAITING_USER_DISAMBIGUATE:
      "Encontré más de un contrato asociado a tu cédula. Por favor indícame cuál de ellos presenta problemas (responde con el número de opción o la dirección).",
    WAITING_USER_DIAGNOSTIC: "{{question}}",
    WAITING_USER_PAYMENT:
      "Detectamos un saldo pendiente de {{debt}} en tu cuenta. Cuando regularices el pago podemos continuar con el soporte técnico.",
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
    WAITING_NATIONAL_ID: validateClient,
    WAITING_USER_DISAMBIGUATE: disambiguateContract,
    CHECK_CLIENT_STATUS: checkClientStatus,
    CHECK_BALANCE: checkBalance,
    RESPOND_DEBT: respondDebt,
    WAITING_USER_PAYMENT: respondDebt,
    DIAGNOSTIC: diagnostic,
    WAITING_USER_DIAGNOSTIC: diagnostic,
  },
};
