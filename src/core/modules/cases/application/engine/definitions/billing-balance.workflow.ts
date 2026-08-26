import type { CaseContext } from "../../../domain/contexts/case-context";
import type { BillingBalanceContext } from "../../../domain/contexts/billing-balance.context";
import { resetWaitingAttempts } from "../../../domain/contexts/engine-meta";
import type { WorkflowDefinition, WorkflowStateHandler } from "../workflow-definition";

/**
 * BILLING_BALANCE (docs/spec/02_STATE_MACHINE.md §15 + §13 WaitingSteps).
 *
 * VALIDATE_CLIENT → CHECK_BALANCE →
 *   hasDebt=false → RESPOND_NO_DEBT → COMPLETED
 *   hasDebt=true  → RESPOND_DEBT_WITH_OPTIONS → COMPLETED
 *   purpose=record_payment → RECORD_PAYMENT | WAITING_USER_RECEIPT
 */

type ValidateClientContractResult = {
  id: string;
  name: string;
  address?: string;
  status?: string;
  router?: { sector: string; olt_name: string; pon: string; serial: string };
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

function requireBillingContext(context: CaseContext): BillingBalanceContext {
  if (context.workflowType !== "BILLING_BALANCE") {
    throw new Error(`Contexto invalido para BILLING_BALANCE: workflowType='${context.workflowType}'`);
  }
  return context.data;
}

function withContext(data: BillingBalanceContext, base?: CaseContext): CaseContext {
  return {
    workflowType: "BILLING_BALANCE",
    data,
    _engine: base?._engine,
  };
}

function mergePaymentFromEntities(
  data: BillingBalanceContext,
  entities?: Record<string, unknown>,
): BillingBalanceContext {
  if (!entities) return data;
  const amountRaw = entities.amount;
  const amount =
    typeof amountRaw === "number"
      ? amountRaw
      : typeof amountRaw === "string" && amountRaw.trim() !== ""
        ? Number(amountRaw)
        : undefined;
  const reference =
    typeof entities.reference === "string" ? entities.reference.trim() : undefined;
  const date = typeof entities.date === "string" ? entities.date.trim() : undefined;

  if (amount === undefined && !reference && !date) return data;

  return {
    ...data,
    payment: {
      ...data.payment,
      ...(Number.isFinite(amount) ? { amount } : {}),
      ...(reference ? { reference } : {}),
      ...(date ? { date } : {}),
      status: data.payment?.status ?? "PENDING",
    },
  };
}

function hasCompletePayment(data: BillingBalanceContext): boolean {
  return (
    data.payment?.amount !== undefined &&
    Number.isFinite(data.payment.amount) &&
    typeof data.payment.reference === "string" &&
    data.payment.reference.trim() !== ""
  );
}

function resolvePurpose(
  data: BillingBalanceContext,
  entities?: Record<string, unknown>,
): "balance" | "record_payment" {
  if (data.purpose === "record_payment" || data.purpose === "balance") return data.purpose;
  if (entities?.billingPurpose === "record_payment") return "record_payment";
  if (hasCompletePayment(mergePaymentFromEntities(data, entities))) return "record_payment";
  return "balance";
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
  let data = requireBillingContext(context);
  data = {
    ...data,
    purpose: resolvePurpose(data, entities),
  };
  data = mergePaymentFromEntities(data, entities);

  // §14: identidad ya validada en esta conversación → saltar cédula y n8n.
  if (identity) {
    const reused = await identity.tryGetValidatedIdentity(conversationId);
    if (reused) {
      const nextData: BillingBalanceContext = {
        ...data,
        client: { nationalId: reused.nationalId, fullName: reused.fullName },
      };
      return { type: "CONTINUE", nextState: "CHECK_BALANCE", context: withContext(nextData, context) };
    }
  }

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

  const found = output.contracts[0]!;
  const nextData: BillingBalanceContext = {
    ...data,
    client: { nationalId: data.client.nationalId, fullName: found.name },
  };
  if (identity) {
    const router = found.router;
    await identity.rememberValidatedIdentity({
      conversationId,
      nationalId: data.client.nationalId,
      fullName: found.name,
      contract: {
        contractNumber: found.id,
        sector: router?.sector,
        oltName: router?.olt_name,
        pon: router?.pon,
        serial: router?.serial,
      },
    });
  }
  return { type: "CONTINUE", nextState: "CHECK_BALANCE", context: withContext(nextData, context) };
};

const checkBalance: WorkflowStateHandler = async ({
  caseId,
  conversationId,
  correlationId,
  context,
  gateway,
  entities,
}) => {
  let data = requireBillingContext(context);
  data = mergePaymentFromEntities(data, entities);
  data = { ...data, purpose: resolvePurpose(data, entities) };

  const result = await gateway.executeAction({
    action: "CHECK_BALANCE",
    caseId,
    conversationId,
    correlationId,
    input: { id: data.client?.nationalId ?? null },
  });

  if (!result.success) {
    return { type: "ESCALATED", reason: result.error.message, context: withContext(data, context) };
  }

  const output = result.result as CheckBalanceOutput;
  data = {
    ...data,
    balance: { hasDebt: output.hasDebt, amount: output.debt },
    invoices:
      output.hasDebt && output.debt !== undefined
        ? [{ id: "current", amount: output.debt, dueDate: "" }]
        : data.invoices,
  };

  if (data.purpose === "record_payment") {
    if (hasCompletePayment(data)) {
      return { type: "CONTINUE", nextState: "RECORD_PAYMENT", context: withContext(data, context) };
    }
    const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_RECEIPT");
    return { type: "WAITING_USER", nextState: "WAITING_USER_RECEIPT", context: waiting };
  }

  // §15: dos estados distintos — la plantilla se elige por estado, no condicionado a medias.
  if (output.hasDebt) {
    return {
      type: "CONTINUE",
      nextState: "RESPOND_DEBT_WITH_OPTIONS",
      context: withContext(data, context),
    };
  }
  return { type: "CONTINUE", nextState: "RESPOND_NO_DEBT", context: withContext(data, context) };
};

const respondNoDebt: WorkflowStateHandler = async ({ context }) => {
  return { type: "COMPLETED", context };
};

const respondDebtWithOptions: WorkflowStateHandler = async ({ context }) => {
  return { type: "COMPLETED", context };
};

const waitingReceipt: WorkflowStateHandler = async ({ context, entities }) => {
  let data = requireBillingContext(context);
  data = mergePaymentFromEntities(data, entities);
  data = { ...data, purpose: "record_payment" };

  if (!hasCompletePayment(data)) {
    const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_RECEIPT");
    return { type: "WAITING_USER", nextState: "WAITING_USER_RECEIPT", context: waiting };
  }

  return { type: "CONTINUE", nextState: "RECORD_PAYMENT", context: withContext(data, context) };
};

const recordPayment: WorkflowStateHandler = async ({
  caseId,
  conversationId,
  correlationId,
  context,
  gateway,
  entities,
}) => {
  let data = requireBillingContext(context);
  data = mergePaymentFromEntities(data, entities);

  if (!hasCompletePayment(data)) {
    const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_RECEIPT");
    return { type: "WAITING_USER", nextState: "WAITING_USER_RECEIPT", context: waiting };
  }

  const result = await gateway.executeAction({
    action: "RECORD_PAYMENT",
    caseId,
    conversationId,
    correlationId,
    input: {
      nationalId: data.client?.nationalId ?? null,
      amount: data.payment!.amount,
      reference: data.payment!.reference,
      date: data.payment?.date ?? null,
    },
  });

  if (!result.success) {
    const nextData: BillingBalanceContext = {
      ...data,
      payment: { ...data.payment, status: "REJECTED" },
    };
    return {
      type: "ESCALATED",
      reason: result.error.message,
      context: withContext(nextData, context),
    };
  }

  const nextData: BillingBalanceContext = {
    ...data,
    payment: { ...data.payment, status: "RECORDED" },
  };
  return { type: "COMPLETED", context: withContext(nextData, context) };
};

export const billingBalanceWorkflow: WorkflowDefinition = {
  workflowType: "BILLING_BALANCE",
  initialState: "VALIDATE_CLIENT",
  expirationHours: 24,
  waitingSteps: {
    WAITING_USER_CLIENT: {
      pendingQuestion: "Para consultar el saldo, ¿me confirmas el número de cédula del titular del servicio?",
      requireAll: ["nationalId"],
      maxAttempts: 5,
    },
    WAITING_USER_RECEIPT: {
      pendingQuestion:
        "Envíame la foto de tu comprobante de pago (necesitamos el monto y el número de referencia).",
      requireAll: ["amount", "reference"],
      maxAttempts: 4,
    },
  },
  replyTemplates: {
    WAITING_USER_CLIENT: "Para consultar el saldo, ¿me confirmas el número de cédula del titular del servicio?",
    WAITING_USER_RECEIPT:
      "Envíame la foto de tu comprobante de pago (necesitamos el monto y el número de referencia).",
    RESPOND_NO_DEBT:
      "Revisé tu cuenta y no tienes ningún saldo pendiente en este momento.",
    RESPOND_DEBT_WITH_OPTIONS:
      "Revisé tu cuenta y encontré un saldo pendiente de ${{debt}}. Si ya realizaste el pago, envíame la foto del comprobante y lo registro; si no, cuéntame si necesitas ayuda con las formas de pago disponibles.",
    COMPLETED:
      "Listo. {{paymentMessage}} Si necesitas algo más de facturación, escríbenos.",
    ESCALATED:
      "¡Recibido, gracias! 🙌 Estamos verificando tu pago y te confirmamos por aquí mismo en cuanto quede listo. ¡Gracias por tu confianza!",
    ACTIVE: "Estamos revisando tu cuenta. Un momento por favor.",
  },
  states: {
    VALIDATE_CLIENT: validateClient,
    WAITING_USER_CLIENT: validateClient,
    CHECK_BALANCE: checkBalance,
    RESPOND_NO_DEBT: respondNoDebt,
    RESPOND_DEBT_WITH_OPTIONS: respondDebtWithOptions,
    WAITING_USER_RECEIPT: waitingReceipt,
    RECORD_PAYMENT: recordPayment,
  },
};
