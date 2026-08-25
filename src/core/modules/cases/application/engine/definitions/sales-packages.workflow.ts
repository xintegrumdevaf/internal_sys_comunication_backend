import type { CaseContext } from "../../../domain/contexts/case-context";
import type { SalesPackagesContext } from "../../../domain/contexts/sales-packages.context";
import { resetWaitingAttempts } from "../../../domain/contexts/engine-meta";
import type { WorkflowDefinition, WorkflowStateHandler } from "../workflow-definition";
import type { RagService } from "../../../../ai/application/services/rag.service";

/**
 * SALES_PACKAGES (docs/spec/05_BUILD_PLAN.md Etapa 8 + §13 WaitingSteps).
 *
 * COLLECT_PREFERENCE → QUERY_PACKAGES → RESPOND_OFFER →
 *   purpose=packages → COMPLETED
 *   purpose=upgrade → WAITING_USER_UPGRADE / ESCALATED a ventas
 */

type KnowledgeOutput = {
  found: boolean;
  answer?: string;
  sources?: string[];
  planId?: string;
  price?: number;
  speed?: string;
  name?: string;
};

function requireSalesContext(context: CaseContext): SalesPackagesContext {
  if (context.workflowType !== "SALES_PACKAGES") {
    throw new Error(`Contexto invalido para SALES_PACKAGES: workflowType='${context.workflowType}'`);
  }
  return context.data;
}

function withContext(data: SalesPackagesContext, base?: CaseContext): CaseContext {
  return {
    workflowType: "SALES_PACKAGES",
    data,
    _engine: base?._engine,
  };
}

function resolvePurpose(
  data: SalesPackagesContext,
  entities?: Record<string, unknown>,
): "packages" | "upgrade" {
  if (data.purpose === "upgrade" || data.purpose === "packages") return data.purpose;
  if (entities?.salesPurpose === "upgrade") return "upgrade";
  return "packages";
}

function mergeSpeed(
  data: SalesPackagesContext,
  entities?: Record<string, unknown>,
  text?: string,
): SalesPackagesContext {
  const fromEntities =
    typeof entities?.requestedSpeed === "string" ? entities.requestedSpeed.trim() : "";
  if (fromEntities) {
    return { ...data, requestedSpeed: fromEntities };
  }
  // Heurística leve: "500 megas" / "500 Mbps" en el texto si aún no hay velocidad.
  if (!data.requestedSpeed && text) {
    const match = text.match(/(\d+)\s*(megas?|mbps|Mbps|MB)/i);
    if (match) {
      return { ...data, requestedSpeed: `${match[1]} Mbps` };
    }
  }
  return data;
}

const collectPreference: WorkflowStateHandler = async ({ context, entities, text }) => {
  let data = requireSalesContext(context);
  data = { ...data, purpose: resolvePurpose(data, entities) };
  data = mergeSpeed(data, entities, text);

  // Sin velocidad pedida: preguntar una vez (requireAny). Si el usuario no la da,
  // QUERY_PACKAGES igual puede correr con pregunta genérica.
  if (!data.requestedSpeed && data.purpose === "packages") {
    if (entities && Object.keys(entities).length === 0 && text && text.trim().length < 8) {
      const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_SPEED");
      return { type: "WAITING_USER", nextState: "WAITING_USER_SPEED", context: waiting };
    }
  }

  return { type: "CONTINUE", nextState: "QUERY_PACKAGES", context: withContext(data, context) };
};

const waitingSpeed: WorkflowStateHandler = async ({ context, entities, text }) => {
  let data = requireSalesContext(context);
  data = mergeSpeed(data, entities, text);
  data = { ...data, purpose: resolvePurpose(data, entities) };
  return { type: "CONTINUE", nextState: "QUERY_PACKAGES", context: withContext(data, context) };
};

const createQueryPackages = (ragService?: RagService): WorkflowStateHandler => async ({
  caseId,
  conversationId,
  correlationId,
  context,
  gateway,
  text,
}) => {
  const data = requireSalesContext(context);
  const question = data.requestedSpeed
    ? `¿Qué planes de internet de aproximadamente ${data.requestedSpeed} tienen disponibles?`
    : text?.trim() || "¿Qué planes y paquetes de internet ofrecen actualmente?";

  let output: KnowledgeOutput;

  if (ragService) {
    const ragRes = await ragService.query(question, 4);
    output = {
      found: ragRes.found,
      answer: ragRes.answer,
      speed: data.requestedSpeed,
    };
  } else {
    const result = await gateway.executeAction({
      action: "QUERY_KNOWLEDGE_BASE",
      caseId,
      conversationId,
      correlationId,
      input: { question },
    });

    if (!result.success) {
      return { type: "ESCALATED", reason: result.error.message, context };
    }

    output = result.result as KnowledgeOutput;
  }

  if (!output.found) {
    return {
      type: "ESCALATED",
      reason: "No se encontró información de paquetes en la base de conocimiento",
      context,
    };
  }

  const nextData: SalesPackagesContext = {
    ...data,
    offer: {
      planId: output.planId ?? "catalog",
      name: output.name,
      price: output.price ?? 0,
      speed: output.speed ?? data.requestedSpeed,
      answer: output.answer,
    },
  };

  return { type: "CONTINUE", nextState: "RESPOND_OFFER", context: withContext(nextData, context) };
};

const respondOffer: WorkflowStateHandler = async ({ context }) => {
  const data = requireSalesContext(context);
  if (data.purpose === "upgrade") {
    const waiting = resetWaitingAttempts(context, "WAITING_USER_UPGRADE");
    return { type: "WAITING_USER", nextState: "WAITING_USER_UPGRADE", context: waiting };
  }
  return { type: "COMPLETED", context };
};

const waitingUpgrade: WorkflowStateHandler = async ({ context, entities, text }) => {
  // Cualquier respuesta razonable del cliente → escala a ventas humanas para cerrar el cambio.
  const confirmed =
    entities?.confirm === true ||
    entities?.confirm === "yes" ||
    (typeof text === "string" && text.trim().length > 0);

  if (!confirmed) {
    const waiting = resetWaitingAttempts(context, "WAITING_USER_UPGRADE");
    return { type: "WAITING_USER", nextState: "WAITING_USER_UPGRADE", context: waiting };
  }

  return {
    type: "ESCALATED",
    reason: "Cliente quiere cambiar/mejorar su plan — requiere especialista de ventas",
    context,
  };
};

export function createSalesPackagesWorkflow(ragService?: RagService): WorkflowDefinition {
  return {
    workflowType: "SALES_PACKAGES",
    initialState: "COLLECT_PREFERENCE",
    expirationHours: 24,
    waitingSteps: {
      WAITING_USER_SPEED: {
        pendingQuestion: "¿Qué velocidad o plan te interesa? (por ejemplo 100, 300 o 500 Mbps)",
        requireAny: ["requestedSpeed"],
        maxAttempts: 2,
      },
      WAITING_USER_UPGRADE: {
        pendingQuestion:
          "¿Confirmas que quieres que un especialista de ventas gestione el cambio de plan por ti?",
        requireAny: ["confirm", "answer"],
        maxAttempts: 2,
      },
    },
    replyTemplates: {
      WAITING_USER_SPEED: "¿Qué velocidad o plan te interesa? (por ejemplo 100, 300 o 500 Mbps)",
      WAITING_USER_UPGRADE:
        "¿Confirmas que quieres que un especialista de ventas gestione el cambio de plan por ti?",
      RESPOND_OFFER: "{{offerAnswer}}",
      COMPLETED: "{{offerAnswer}}",
      ESCALATED: "Te conectamos con un especialista de ventas para ayudarte con tu plan. En breve te contactan.",
      ACTIVE: "Estamos buscando los planes disponibles. Un momento por favor.",
    },
    states: {
      COLLECT_PREFERENCE: collectPreference,
      WAITING_USER_SPEED: waitingSpeed,
      QUERY_PACKAGES: createQueryPackages(ragService),
      RESPOND_OFFER: respondOffer,
      WAITING_USER_UPGRADE: waitingUpgrade,
    },
  };
}

export const salesPackagesWorkflow = createSalesPackagesWorkflow();
