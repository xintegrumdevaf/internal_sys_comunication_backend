import { describe, expect, it } from "vitest";
import { createGeneralInquiryWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/general-inquiry.workflow";
import type { CaseContext } from "../../../src/core/modules/cases/domain/contexts/case-context";
import type { RagService } from "../../../src/core/modules/ai/application/services/rag.service";

describe("GENERAL_INQUIRY workflow", () => {
  it("cuando la base de conocimiento responde con exito, avanza a RESPOND_ANSWER con la respuesta", async () => {
    const fakeRagService = {
      query: async (_question: string) => ({
        answer: "XGO cuenta con cobertura en Conocoto, Quito.",
        found: true,
        confidenceScore: 0.95,
        sources: ["XGO_Doc.pdf"],
        retrievedChunks: [],
        executionTimeMs: 45,
      }),
    } as unknown as RagService;

    const workflow = createGeneralInquiryWorkflow(fakeRagService);
    const context: CaseContext = {
      workflowType: "GENERAL_INQUIRY",
      data: { question: "¿Tienen cobertura en Conocoto?" },
    };

    const handler = workflow.states.QUERY_KNOWLEDGE_BASE;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("handler QUERY_KNOWLEDGE_BASE is undefined");

    const outcome = await handler({
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      currentState: "QUERY_KNOWLEDGE_BASE",
      context,
      gateway: { executeAction: async () => ({ success: true, result: {} }) },
      entities: { question: "¿Tienen cobertura en Conocoto?" },
    });

    expect(outcome.type).toBe("CONTINUE");
    if (outcome.type === "CONTINUE") {
      expect(outcome.nextState).toBe("RESPOND_ANSWER");
      expect(outcome.context.workflowType).toBe("GENERAL_INQUIRY");
      if (outcome.context.workflowType === "GENERAL_INQUIRY") {
        expect(outcome.context.data.answer).toBe("XGO cuenta con cobertura en Conocoto, Quito.");
        expect(outcome.context.data.found).toBe(true);
      }
    }
  });

  it("cuando la base de conocimiento no encuentra informacion (found: false), escala el caso con UNANSWERED_INQUIRY", async () => {
    const fakeRagService = {
      query: async () => ({
        answer: "No se encontro informacion",
        found: false,
        confidenceScore: 0.0,
        sources: [],
        retrievedChunks: [],
        executionTimeMs: 20,
      }),
    } as unknown as RagService;

    const workflow = createGeneralInquiryWorkflow(fakeRagService);
    const context: CaseContext = {
      workflowType: "GENERAL_INQUIRY",
      data: { question: "¿Tienen sucursal en Galápagos?" },
    };

    const handler = workflow.states.QUERY_KNOWLEDGE_BASE;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("handler QUERY_KNOWLEDGE_BASE is undefined");

    const outcome = await handler({
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      currentState: "QUERY_KNOWLEDGE_BASE",
      context,
      gateway: { executeAction: async () => ({ success: true, result: {} }) },
      entities: { question: "¿Tienen sucursal en Galápagos?" },
    });

    expect(outcome.type).toBe("ESCALATED");
    if (outcome.type === "ESCALATED") {
      expect(outcome.reason).toContain("base de conocimiento");
      expect(outcome.context.workflowType).toBe("GENERAL_INQUIRY");
      if (outcome.context.workflowType === "GENERAL_INQUIRY") {
        expect(outcome.context.data.found).toBe(false);
      }
    }
  });

  it("el estado RESPOND_ANSWER completa el caso exitosamente", async () => {
    const fakeRagService = {} as unknown as RagService;
    const workflow = createGeneralInquiryWorkflow(fakeRagService);

    const context: CaseContext = {
      workflowType: "GENERAL_INQUIRY",
      data: {
        question: "¿Cuál es el RUC?",
        answer: "El RUC de XGO es 1799999999001",
        found: true,
      },
    };

    const handler = workflow.states.RESPOND_ANSWER;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("handler RESPOND_ANSWER is undefined");

    const outcome = await handler({
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      currentState: "RESPOND_ANSWER",
      context,
      gateway: { executeAction: async () => ({ success: true, result: {} }) },
    });

    expect(outcome.type).toBe("COMPLETED");
  });

  it("responde con 'Buenos días' si el cliente dice 'Buenos dias' y mantiene el caso en WAITING_USER_INQUIRY", async () => {
    const fakeRagService = {} as unknown as RagService;
    const workflow = createGeneralInquiryWorkflow(fakeRagService);

    const context: CaseContext = {
      workflowType: "GENERAL_INQUIRY",
      data: { question: "Buenos dias" },
    };

    const handler = workflow.states.QUERY_KNOWLEDGE_BASE;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("handler QUERY_KNOWLEDGE_BASE is undefined");

    const outcome = await handler({
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      currentState: "QUERY_KNOWLEDGE_BASE",
      context,
      text: "Buenos dias",
      gateway: { executeAction: async () => ({ success: true, result: {} }) },
    });

    expect(outcome.type).toBe("WAITING_USER");
    if (outcome.type === "WAITING_USER") {
      expect(outcome.nextState).toBe("WAITING_USER_INQUIRY");
      if (outcome.context.workflowType === "GENERAL_INQUIRY") {
        expect(outcome.context.data.answer).toContain("Buenos días");
        expect(outcome.context.data.answer).not.toContain("Buenas tardes");
      }
    }
  });

  it("responde como saludo y mantiene el caso en WAITING_USER_INQUIRY si el cliente dice 'Hola que tal'", async () => {
    const fakeRagService = {
      query: async () => {
        throw new Error("RAG no deberia ser llamado para un saludo");
      },
    } as unknown as RagService;
    const workflow = createGeneralInquiryWorkflow(fakeRagService);

    const context: CaseContext = {
      workflowType: "GENERAL_INQUIRY",
      data: { question: "Hola que tal" },
    };

    const handler = workflow.states.QUERY_KNOWLEDGE_BASE;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("handler QUERY_KNOWLEDGE_BASE is undefined");

    const outcome = await handler({
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      currentState: "QUERY_KNOWLEDGE_BASE",
      context,
      text: "Hola que tal",
      gateway: { executeAction: async () => ({ success: true, result: {} }) },
    });

    expect(outcome.type).toBe("WAITING_USER");
    if (outcome.type === "WAITING_USER") {
      expect(outcome.nextState).toBe("WAITING_USER_INQUIRY");
      if (outcome.context.workflowType === "GENERAL_INQUIRY") {
        expect(outcome.context.data.found).toBe(true);
        expect(outcome.context.data.answer).toContain("¿En qué te podemos ayudar hoy?");
      }
    }
  });

  it("en estado WAITING_USER_INQUIRY procesa la consulta con RAG y avanza a RESPOND_ANSWER", async () => {
    const fakeRagService = {
      query: async (_question: string) => ({
        answer: "Nuestros horarios son de lunes a viernes de 8:00 a 18:00.",
        found: true,
        confidenceScore: 0.9,
        sources: ["Horarios.pdf"],
        retrievedChunks: [],
        executionTimeMs: 30,
      }),
    } as unknown as RagService;
    const workflow = createGeneralInquiryWorkflow(fakeRagService);

    const context: CaseContext = {
      workflowType: "GENERAL_INQUIRY",
      data: {
        answer: "¡Hola! ¿En qué te podemos ayudar hoy?",
        found: true,
      },
    };

    const handler = workflow.states.WAITING_USER_INQUIRY;
    expect(handler).toBeDefined();
    if (!handler) throw new Error("handler WAITING_USER_INQUIRY is undefined");

    const outcome = await handler({
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      currentState: "WAITING_USER_INQUIRY",
      context,
      text: "¿Cuáles son sus horarios de atención?",
      entities: { answer: "¿Cuáles son sus horarios de atención?" },
      gateway: { executeAction: async () => ({ success: true, result: {} }) },
    });

    expect(outcome.type).toBe("CONTINUE");
    if (outcome.type === "CONTINUE") {
      expect(outcome.nextState).toBe("RESPOND_ANSWER");
      if (outcome.context.workflowType === "GENERAL_INQUIRY") {
        expect(outcome.context.data.answer).toBe("Nuestros horarios son de lunes a viernes de 8:00 a 18:00.");
      }
    }
  });
});
