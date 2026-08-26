import { describe, expect, it } from "vitest";
import {
  InterpretMessageUseCase,
  tryDeterministicSingleNumericField,
} from "../../src/core/modules/ai/application/use-cases/interpret-message.use-case";
import { buildInterpretMessagePrompt } from "../../src/core/modules/ai/application/prompts/interpret-message.prompt";
import { FakeAIProvider } from "../../src/core/modules/ai/infrastructure/fake/fake-ai.provider";
import { AdvanceCaseUseCase } from "../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { WorkflowEngine } from "../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import { CaseRepositoryFake, N8nGatewayFake, WorkflowExecutionRepositoryFake } from "../cases/fakes";
import { ConversationRepositoryFake } from "../support/fakes";
import { silentLogger } from "../support/silent-logger";

describe("06_AI_PROMPTS.md §6 — regresion WaitingStep / entities", () => {
  it("requireAll nationalId + mensaje solo digitos → ANSWER determinista", () => {
    const result = tryDeterministicSingleNumericField({
      correlationId: "c1",
      conversationId: "conv1",
      messageId: "m1",
      text: "16272728",
      conversationSnapshot: {
        activeCase: {
          workflowType: "SUPPORT_INTERNET",
          pendingQuestion: "¿podrías confirmar tu número de cédula?",
          requireAll: ["nationalId"],
        },
      },
    });
    expect(result).toEqual({
      type: "ANSWER",
      intent: "support.internet",
      entities: { nationalId: "16272728" },
      confidence: 0.99,
    });
  });

  it("InterpretMessageUseCase: FakeAI con requireAll nationalId responde ANSWER", async () => {
    const fake = new FakeAIProvider();
    fake.interpretImpl = async (input) => {
      const requireAll = input.conversationSnapshot.activeCase?.requireAll ?? [];
      expect(requireAll).toEqual(["nationalId"]);
      return {
        type: "ANSWER",
        intent: "support.internet",
        entities: { nationalId: input.text.trim() },
        confidence: 0.9,
      };
    };
    const useCase = new InterpretMessageUseCase(fake, silentLogger);
    const result = await useCase.execute({
      correlationId: "c1",
      conversationId: "conv1",
      messageId: "m1",
      text: "16272728",
      conversationSnapshot: {
        activeCase: {
          workflowType: "SUPPORT_INTERNET",
          pendingQuestion: "¿podrías confirmar tu número de cédula?",
          requireAll: ["nationalId"],
        },
      },
    });
    expect(result.type).toBe("ANSWER");
    expect(result.entities.nationalId).toBe("16272728");
  });

  it("prompt inyecta requireAny address/fullName (desambiguar contrato)", () => {
    const { user } = buildInterpretMessagePrompt({
      correlationId: "c1",
      conversationId: "conv1",
      messageId: "m1",
      text: "vivo en la Av. Amazonas",
      conversationSnapshot: {
        activeCase: {
          workflowType: "SUPPORT_INTERNET",
          pendingQuestion:
            "Encontré más de un contrato a tu nombre, ¿me confirmas tu dirección o el nombre completo del titular?",
          requireAny: ["address", "fullName"],
        },
      },
    });
    const payload = JSON.parse(user) as Record<string, unknown>;
    expect(payload["datos requeridos (alguno)"]).toEqual(["address", "fullName"]);
    expect(payload["datos requeridos (todos)"]).toBeNull();
  });

  it("InterpretMessageUseCase: requireAny address/fullName (desambiguar)", async () => {
    const fake = new FakeAIProvider();
    fake.interpretImpl = async (input) => {
      expect(input.conversationSnapshot.activeCase?.requireAny).toEqual(["address", "fullName"]);
      return {
        type: "ANSWER",
        intent: "support.internet",
        entities: { address: "Av. Amazonas" },
        confidence: 0.91,
      };
    };
    const useCase = new InterpretMessageUseCase(fake, silentLogger);
    const result = await useCase.execute({
      correlationId: "c1",
      conversationId: "conv1",
      messageId: "m1",
      text: "vivo en la Av. Amazonas",
      conversationSnapshot: {
        activeCase: {
          workflowType: "SUPPORT_INTERNET",
          pendingQuestion:
            "Encontré más de un contrato a tu nombre, ¿me confirmas tu dirección o el nombre completo del titular?",
          requireAny: ["address", "fullName"],
        },
      },
    });
    expect(result.type).toBe("ANSWER");
    expect(result.entities.address).toBe("Av. Amazonas");
  });

  it("InterpretMessageUseCase: requireAll answer (diagnostico)", async () => {
    const fake = new FakeAIProvider();
    fake.interpretImpl = async (input) => ({
      type: "ANSWER",
      intent: "support.internet",
      entities: { answer: input.text },
      confidence: 0.92,
    });
    const useCase = new InterpretMessageUseCase(fake, silentLogger);
    const result = await useCase.execute({
      correlationId: "c1",
      conversationId: "conv1",
      messageId: "m1",
      text: "ya reinicie el router",
      conversationSnapshot: {
        activeCase: {
          workflowType: "SUPPORT_INTERNET",
          pendingQuestion: "¿Ya reiniciaste el router?",
          requireAll: ["answer"],
        },
      },
    });
    expect(result.type).toBe("ANSWER");
    expect(result.entities.answer).toBe("ya reinicie el router");
  });

  it("motor §13: texto conversacional sin cedula mantiene WAITING_USER sin quemar intentos", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const conversation = conversationRepo.createOpen();
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({});
    const advance = new AdvanceCaseUseCase({
      caseRepo,
      workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
      conversationRepo,
      engine,
      gateway,
      logger: silentLogger,
    });

    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    // Primer avance sin cedula → WAITING_USER_CLIENT
    const first = await advance.execute({ caseId: created.id, correlationId: "c1", text: "" });
    expect(first.outcome.type).toBe("WAITING_USER");
    if (first.outcome.type === "WAITING_USER") {
      expect(first.outcome.nextState).toBe("WAITING_USER_CLIENT");
    }

    // Texto conversacional 1 ("hola") → WAITING_USER sin incrementar intentos
    const second = await advance.execute({
      caseId: created.id,
      correlationId: "c2",
      text: "hola",
      entities: {},
    });
    expect(second.outcome.type).toBe("WAITING_USER");
    expect(second.case.context._engine?.waitingAttempts ?? 0).toBe(0);

    // Texto conversacional 2 ("???") → se mantiene WAITING_USER sin escalar
    const third = await advance.execute({
      caseId: created.id,
      correlationId: "c3",
      text: "???",
      entities: {},
    });
    expect(third.outcome.type).toBe("WAITING_USER");
    expect(third.case.context._engine?.waitingAttempts ?? 0).toBe(0);
  });

  it("motor §13: nationalId valido avanza VALIDATE_CLIENT", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const conversation = conversationRepo.createOpen();
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [
            {
              id: "16272728",
              name: "Ana",
              router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1" },
            },
          ],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
      DIAGNOSTIC: () => ({
        success: true,
        result: { status: "WAITING_USER", question: "¿La luz ONU esta roja?" },
      }),
    });
    const advance = new AdvanceCaseUseCase({
      caseRepo,
      workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
      conversationRepo,
      engine,
      gateway,
      logger: silentLogger,
    });

    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    await advance.execute({ caseId: created.id, correlationId: "c1" });
    const afterCedula = await advance.execute({
      caseId: created.id,
      correlationId: "c2",
      text: "16272728",
      entities: { nationalId: "16272728" },
    });
    expect(afterCedula.outcome.type).toBe("WAITING_USER");
    if (afterCedula.outcome.type === "WAITING_USER") {
      expect(afterCedula.outcome.nextState).toBe("WAITING_USER_DIAGNOSTIC");
    }
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(1);
    expect(gateway.actionsCalledFor("CHECK_BALANCE")).toBe(1);
    expect(gateway.actionsCalledFor("DIAGNOSTIC")).toBe(1);
  });

  it("motor §13: answer boolean del LLM se normaliza al texto del usuario", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const conversation = conversationRepo.createOpen();
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      CONTINUE_DIAGNOSTIC: (params) => {
        const message = (params.input as { message?: string }).message ?? "";
        expect(message).toBe("si reinicie");
        return { success: true, result: { status: "COMPLETED", diagnostic: "OK" } };
      },
    });
    const advance = new AdvanceCaseUseCase({
      caseRepo,
      workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
      conversationRepo,
      engine,
      gateway,
      logger: silentLogger,
    });

    const { case: created, workflowInstance } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: {
        workflowType: "SUPPORT_INTERNET",
        data: { diagnostic: { status: "PENDING", lastQuestion: "¿Reiniciaste?" } },
      },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: workflowInstance.version,
      status: "WAITING_USER",
      context: created.context,
      currentState: "WAITING_USER_DIAGNOSTIC",
      expiresAt: null,
    });

    const result = await advance.execute({
      caseId: created.id,
      correlationId: "c-bool",
      text: "si reinicie",
      entities: { answer: true },
    });
    expect(result.case.status).toBe("COMPLETED");
  });
});
