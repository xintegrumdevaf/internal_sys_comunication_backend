import { describe, expect, it } from "vitest";
import { AdvanceCaseUseCase } from "../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { WorkflowEngine } from "../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import { billingBalanceWorkflow } from "../../src/core/modules/cases/application/engine/definitions/billing-balance.workflow";
import { CaseRepositoryFake, N8nGatewayFake, WorkflowExecutionRepositoryFake } from "../cases/fakes";
import { ConversationRepositoryFake } from "../support/fakes";
import { ConversationIdentityFake } from "../support/conversation-identity.fake";
import { silentLogger } from "../support/silent-logger";
import { buildInterpretMessagePrompt } from "../../src/core/modules/ai/application/prompts/interpret-message.prompt";
import { FakeAIProvider } from "../../src/core/modules/ai/infrastructure/fake/fake-ai.provider";
import { InterpretMessageUseCase } from "../../src/core/modules/ai/application/use-cases/interpret-message.use-case";

/**
 * Regresión bugs de prueba manual (docs/spec/02_STATE_MACHINE.md §14 +
 * docs/spec/06_AI_PROMPTS.md — intención accionable).
 */
describe("Regresión §14 identidad + mensaje mixto", () => {
  it("SUPPORT y BILLING declaran pendingQuestion distintos para WAITING_USER_CLIENT", () => {
    const supportQ = supportInternetWorkflow.waitingSteps!.WAITING_USER_CLIENT!.pendingQuestion;
    const billingQ = billingBalanceWorkflow.waitingSteps!.WAITING_USER_CLIENT!.pendingQuestion;
    expect(supportQ).toMatch(/internet/i);
    expect(billingQ).toMatch(/saldo/i);
    expect(supportQ).not.toBe(billingQ);
  });

  it("segundo caso en la misma conversación no vuelve a pedir cédula ni llama VALIDATE_CLIENT", async () => {
    const identity = new ConversationIdentityFake();
    const conversationRepo = new ConversationRepositoryFake();
    const conversation = conversationRepo.createOpen();
    identity.seed(conversation.id, {
      nationalId: "1205500216",
      fullName: "Ana",
      contract: {
        id: "1205500216",
        sector: "pomasqui",
        oltName: "olt1",
        pon: "3",
        serial: "S1",
      },
    });

    const caseRepo = new CaseRepositoryFake();
    const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [
            {
              id: "1205500216",
              name: "Ana",
              router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1" },
            },
          ],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
      DIAGNOSTIC: () => ({
        success: true,
        result: { status: "WAITING_USER", question: "¿ONU encendida?" },
      }),
    });
    const engine = new WorkflowEngine([supportInternetWorkflow, billingBalanceWorkflow]);
    const advanceCase = new AdvanceCaseUseCase({
      caseRepo,
      workflowExecutionRepo,
      conversationRepo,
      engine,
      gateway,
      logger: silentLogger,
      identity,
    });

    // Caso de facturación (segundo tema) — no debe pedir cédula.
    const { case: billingCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "BILLING_BALANCE",
      departmentId: null,
      context: { workflowType: "BILLING_BALANCE", data: { purpose: "balance" } },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await conversationRepo.setActiveCaseId(conversation.id, billingCase.id);

    const result = await advanceCase.execute({
      caseId: billingCase.id,
      correlationId: "corr-reuse",
    });

    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(0);
    expect(gateway.actionsCalledFor("CHECK_BALANCE")).toBe(1);
    expect(result.outcome.type).not.toBe("WAITING_USER");
    if (result.case.context.workflowType === "BILLING_BALANCE") {
      expect(result.case.context.data.client?.nationalId).toBe("1205500216");
    }
    // No debe haber preguntado cédula (WAITING_USER_CLIENT).
    if (result.outcome.type === "WAITING_USER") {
      expect(result.outcome.nextState).not.toBe("WAITING_USER_CLIENT");
    }
  });

  it("VALIDATE_CLIENT exitoso recuerda identidad para reutilizar luego", async () => {
    const identity = new ConversationIdentityFake();
    const conversationRepo = new ConversationRepositoryFake();
    const conversation = conversationRepo.createOpen();
    const caseRepo = new CaseRepositoryFake();
    const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [
            {
              id: "C-1",
              name: "Ana",
              router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1" },
            },
          ],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
      DIAGNOSTIC: () => ({
        success: true,
        result: { status: "WAITING_USER", question: "¿ONU?" },
      }),
    });
    const advanceCase = new AdvanceCaseUseCase({
      caseRepo,
      workflowExecutionRepo,
      conversationRepo,
      engine: new WorkflowEngine([supportInternetWorkflow]),
      gateway,
      logger: silentLogger,
      identity,
    });

    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await advanceCase.execute({
      caseId: created.id,
      correlationId: "corr-remember",
      entities: { nationalId: "1205500216" },
    });

    expect(identity.rememberCalls).toBe(1);
    const stored = await identity.tryGetValidatedIdentity(conversation.id);
    expect(stored?.nationalId).toBe("1205500216");
    expect(stored?.contract.id).toBe("C-1");
  });

  it("prompt prioriza intención accionable: ejemplo deuda+internet → support.internet", () => {
    const { system } = buildInterpretMessagePrompt({
      correlationId: "c1",
      conversationId: "conv1",
      messageId: "m1",
      text: "Ya no tengo deuda pendiente, valida mi problema de internet.",
      conversationSnapshot: {},
    });
    expect(system).toMatch(/valida mi problema de internet/i);
    expect(system).toMatch(/support\.internet/);
    expect(system).toMatch(/acción que el cliente pide explícitamente|accionable/i);
  });

  it("InterpretMessageUseCase: mensaje mixto se clasifica como support.internet (no billing)", async () => {
    const fake = new FakeAIProvider();
    fake.interpretImpl = async (input) => {
      // Simula el contrato del prompt: priorizar acción explícita sobre mención de contexto.
      const text = input.text.toLowerCase();
      const asksInternet = /problema de internet|no tengo internet|valida mi (problema|conex)/i.test(
        text,
      );
      const onlyMentionsDebt = /deuda|saldo/.test(text) && !asksInternet;
      if (asksInternet) {
        return {
          type: "NEW_INTENT",
          intent: "support.internet",
          entities: {},
          confidence: 0.85,
        };
      }
      if (onlyMentionsDebt) {
        return {
          type: "NEW_INTENT",
          intent: "billing.balance",
          entities: {},
          confidence: 0.9,
        };
      }
      return { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0.3 };
    };
    const useCase = new InterpretMessageUseCase(fake, silentLogger);
    const result = await useCase.execute({
      correlationId: "c-mix",
      conversationId: "conv-mix",
      messageId: "m-mix",
      text: "Ya no tengo deuda pendiente, valida mi problema de internet.",
      conversationSnapshot: {},
    });
    expect(result.intent).toBe("support.internet");
    expect(result.intent).not.toBe("billing.balance");
  });
});
