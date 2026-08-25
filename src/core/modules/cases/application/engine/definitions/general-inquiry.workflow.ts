import type { CaseContext } from "../../../domain/contexts/case-context";
import type { GeneralInquiryContext } from "../../../domain/contexts/general-inquiry.context";
import { resetWaitingAttempts } from "../../../domain/contexts/engine-meta";
import type { WorkflowDefinition, WorkflowStateHandler } from "../workflow-definition";
import type { RagService } from "../../../../ai/application/services/rag.service";

/**
 * GENERAL_INQUIRY — workflow unificado para consultas informacionales vía RAG.
 *
 * Cubre intents: general.inquiry, sales.packages, sales.upgrade.
 *
 * Flujo:
 *   QUERY_KNOWLEDGE_BASE → RAG responde → RESPOND_ANSWER → COMPLETED
 *
 * Si el intent original era sales.upgrade (cliente quiere contratar/mejorar):
 *   QUERY_KNOWLEDGE_BASE → RAG responde → WAITING_USER_SPECIALIST
 *   → cliente confirma → ESCALATED a ventas
 *
 * Si RAG no tiene información suficiente → ESCALATED con motivo UNANSWERED_INQUIRY
 * (notifica a managers/admin para que decidan a qué departamento derivar).
 */

function requireContext(context: CaseContext): GeneralInquiryContext {
  if (context.workflowType !== "GENERAL_INQUIRY") {
    throw new Error(`Contexto invalido para GENERAL_INQUIRY: workflowType='${context.workflowType}'`);
  }
  return context.data;
}

function withContext(data: GeneralInquiryContext, base?: CaseContext): CaseContext {
  return {
    workflowType: "GENERAL_INQUIRY",
    data,
    _engine: base?._engine,
  };
}

export function createGeneralInquiryWorkflow(ragService: RagService): WorkflowDefinition {
  const queryKnowledgeBase: WorkflowStateHandler = async ({ context, entities, text }) => {
    let data = requireContext(context);

    // La pregunta puede venir de entities.question, el texto directo, o el campo almacenado
    const question =
      typeof entities?.question === "string" && entities.question.trim() !== ""
        ? entities.question.trim()
        : typeof entities?.location === "string"
          ? `¿Tienen cobertura en ${entities.location}?`
          : text || data.question || "";

    // Detectar si el intent original era de upgrade (cliente quiere contratar/mejorar plan)
    const wantsUpgrade =
      data.wantsUpgrade ||
      entities?.salesPurpose === "upgrade" ||
      entities?.intent === "sales.upgrade";

    data = { ...data, question, wantsUpgrade };

    const result = await ragService.query(question, 4);

    if (!result.found || result.confidenceScore < 0.5) {
      const nextData: GeneralInquiryContext = {
        ...data,
        found: false,
        escalationReason: "UNANSWERED_INQUIRY",
      };
      return {
        type: "ESCALATED",
        reason:
          "No se encontró información suficiente en la base de conocimiento para responder la consulta.",
        context: withContext(nextData, context),
      };
    }

    const nextData: GeneralInquiryContext = {
      ...data,
      answer: result.answer,
      found: true,
      confidenceScore: result.confidenceScore,
      sources: result.sources,
      retrievedChunks: result.retrievedChunks,
      wantsUpgrade,
    };

    return {
      type: "CONTINUE",
      nextState: wantsUpgrade ? "WAITING_USER_SPECIALIST" : "RESPOND_ANSWER",
      context: withContext(nextData, context),
    };
  };

  const respondAnswer: WorkflowStateHandler = async ({ context }) => {
    return { type: "COMPLETED", context };
  };

  const waitingUserSpecialist: WorkflowStateHandler = async ({ context, entities, text }) => {
    // Si el cliente confirma → escalar a ventas
    const confirmed =
      entities?.confirm === true ||
      entities?.confirm === "yes" ||
      (typeof text === "string" &&
        /s[ií]|por favor|quiero|dale|adelante|claro|ok|listo/i.test(text.trim()));

    const denied =
      entities?.confirm === false ||
      entities?.confirm === "no" ||
      (typeof text === "string" && /no\b|gracias|ya no|no quiero/i.test(text.trim()));

    if (denied) {
      return { type: "COMPLETED", context };
    }

    if (confirmed) {
      return {
        type: "ESCALATED",
        reason: "Cliente quiere contratar o mejorar su plan — requiere especialista de ventas",
        context,
      };
    }

    // Si no se puede determinar → re-preguntar (hasta maxAttempts)
    const waiting = resetWaitingAttempts(context, "WAITING_USER_SPECIALIST");
    return { type: "WAITING_USER", nextState: "WAITING_USER_SPECIALIST", context: waiting };
  };

  return {
    workflowType: "GENERAL_INQUIRY",
    initialState: "QUERY_KNOWLEDGE_BASE",
    expirationHours: 24,
    waitingSteps: {
      WAITING_USER_SPECIALIST: {
        pendingQuestion:
          "¿Te gustaría que un especialista de ventas te contacte para ayudarte con el proceso de contratación o cambio de plan?",
        requireAny: ["confirm", "answer"],
        maxAttempts: 2,
      },
    },
    replyTemplates: {
      RESPOND_ANSWER: "{{answer}}",
      COMPLETED: "{{answer}}",
      WAITING_USER_SPECIALIST:
        "{{answer}}\n\n¿Te gustaría que un especialista de ventas te contacte para ayudarte con el proceso de contratación o cambio de plan?",
      ESCALATED:
        "Estoy transfiriendo tu consulta a uno de nuestros asesores para brindarte la información exacta. En breve te atenderán por este chat.",
      ACTIVE: "Consultando en la base de conocimiento...",
    },
    states: {
      QUERY_KNOWLEDGE_BASE: queryKnowledgeBase,
      RESPOND_ANSWER: respondAnswer,
      WAITING_USER_SPECIALIST: waitingUserSpecialist,
    },
  };
}
