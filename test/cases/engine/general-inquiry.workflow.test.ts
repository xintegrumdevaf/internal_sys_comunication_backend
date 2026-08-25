import { describe, expect, it } from "vitest";
import { createGeneralInquiryWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/general-inquiry.workflow";
import type { CaseContext } from "../../../src/core/modules/cases/domain/contexts/case-context";
import type { RagService } from "../../../src/core/modules/ai/application/services/rag.service";

describe("GENERAL_INQUIRY workflow", () => {
  it("cuando la base de conocimiento responde con exito, avanza a RESPOND_ANSWER con la respuesta", async () => {
    const fakeRagService = {
      query: async (question: string) => ({
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
});
