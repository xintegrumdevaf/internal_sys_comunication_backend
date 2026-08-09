import { describe, expect, it } from "vitest";
import { ProcessBufferedMessagesUseCase } from "../../../src/core/modules/cases/application/use-cases/process-buffered-messages.use-case";
import { AdvanceCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { CaseArbitrationService } from "../../../src/core/modules/cases/application/services/case-arbitration.service";
import { DepartmentResolverService } from "../../../src/core/modules/cases/application/services/department-resolver.service";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import type { WorkflowDefinition } from "../../../src/core/modules/cases/application/engine/workflow-definition";
import type {
  Interpretation,
  InterpretationPort,
  InterpretMessageInput,
} from "../../../src/core/modules/cases/application/ports/interpretation.port";
import { ComposeCustomerReplyUseCase } from "../../../src/core/modules/ai/application/use-cases/compose-customer-reply.use-case";
import { TranscribeAudioUseCase } from "../../../src/core/modules/ai/application/use-cases/transcribe-audio.use-case";
import { ExtractReceiptDataUseCase } from "../../../src/core/modules/ai/application/use-cases/extract-receipt-data.use-case";
import { FakeAIProvider } from "../../../src/core/modules/ai/infrastructure/fake/fake-ai.provider";
import { CaseRepositoryFake, N8nGatewayFake, WorkflowExecutionRepositoryFake } from "../fakes";
import {
  ConversationRepositoryFake,
  DepartmentRepositoryFake,
  MessageRepositoryFake,
  WhatsAppSenderFake,
} from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

class QueuedInterpretationProvider implements InterpretationPort {
  private readonly queue: Interpretation[];
  constructor(queue: Interpretation[]) {
    this.queue = [...queue];
  }
  async interpretMessage(_input: InterpretMessageInput): Promise<Interpretation> {
    const next = this.queue.shift();
    if (!next) throw new Error("QueuedInterpretationProvider: cola vacia");
    return next;
  }
}

const dummyBillingWorkflow: WorkflowDefinition = {
  workflowType: "BILLING_BALANCE",
  initialState: "COLLECT_INFO",
  expirationHours: 24,
  replyTemplates: {
    COLLECT_INFO: "¿Me confirmas el monto o referencia de tu pago?",
  },
  states: {
    COLLECT_INFO: async ({ context }) => ({ type: "WAITING_USER", nextState: "COLLECT_INFO", context }),
  },
};

function buildScenario() {
  const caseRepo = new CaseRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const messageRepo = new MessageRepositoryFake();
  const whatsappSender = new WhatsAppSenderFake();
  const departmentRepo = new DepartmentRepositoryFake();
  departmentRepo.seed({ slug: "support", name: "Soporte tecnico" });
  departmentRepo.seed({ slug: "billing", name: "Facturacion" });

  const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
  const engine = new WorkflowEngine([supportInternetWorkflow, dummyBillingWorkflow]);
  const gateway = new N8nGatewayFake({
    VALIDATE_CLIENT: () => ({
      success: true,
      result: {
        found: true,
        contractNumbers: 1,
        contracts: [
          { id: "1", name: "Ana", router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1" } },
        ],
      },
    }),
    CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
    DIAGNOSTIC: () => ({ success: true, result: { status: "WAITING_USER", question: "¿La luz ONU esta roja?" } }),
    CONTINUE_DIAGNOSTIC: () => ({ success: true, result: { status: "COMPLETED", diagnostic: "ONU reiniciada" } }),
  });

  const advanceCase = new AdvanceCaseUseCase({
    caseRepo,
    workflowExecutionRepo,
    conversationRepo,
    engine,
    gateway,
    logger: silentLogger,
  });
  const departmentResolver = new DepartmentResolverService(departmentRepo);
  const arbitrationService = new CaseArbitrationService(caseRepo, silentLogger);
  const fakeAi = new FakeAIProvider();
  const composeReply = new ComposeCustomerReplyUseCase(fakeAi);
  const transcribeAudio = new TranscribeAudioUseCase(fakeAi);
  const extractReceiptData = new ExtractReceiptDataUseCase(fakeAi);

  return {
    caseRepo,
    conversationRepo,
    messageRepo,
    whatsappSender,
    departmentRepo,
    engine,
    gateway,
    advanceCase,
    departmentResolver,
    arbitrationService,
    composeReply,
    transcribeAudio,
    extractReceiptData,
  };
}

function textMessages(conversationId: string, messageRepo: MessageRepositoryFake, body: string) {
  return [messageRepo.seedText(conversationId, body)];
}

describe("ProcessBufferedMessagesUseCase (docs/spec/05_BUILD_PLAN.md Etapa 2+5)", () => {
  it(
    "crea el caso con el departamento resuelto por la tabla de mapeo, pausa por cambio de tema " +
      "y reanuda preservando el contexto acumulado",
    async () => {
      const scenario = buildScenario();
      const {
        caseRepo,
        conversationRepo,
        messageRepo,
        whatsappSender,
        departmentRepo,
        engine,
        advanceCase,
        departmentResolver,
        arbitrationService,
        composeReply,
        transcribeAudio,
        extractReceiptData,
      } = scenario;
      const conversation = conversationRepo.createOpen();

      const interpretationProvider = new QueuedInterpretationProvider([
        { type: "NEW_INTENT", intent: "support.internet", entities: {}, confidence: 0.9 },
        {
          type: "ANSWER",
          intent: "support.internet",
          entities: { nationalId: "1" },
          confidence: 0.95,
        },
        { type: "CHANGE_TOPIC", intent: "billing.balance", entities: {}, confidence: 0.9 },
        { type: "CHANGE_TOPIC", intent: "support.internet", entities: {}, confidence: 0.9 },
      ]);

      const useCase = new ProcessBufferedMessagesUseCase({
        caseRepo,
        conversationRepo,
        messageRepo,
        whatsappSender,
        departmentResolver,
        arbitrationService,
        interpretationProvider,
        engine,
        advanceCase,
        composeReply,
        transcribeAudio,
        extractReceiptData,
        logger: silentLogger,
      });

      await useCase.execute({
        conversationId: conversation.id,
        correlationId: "corr-1",
        messages: textMessages(conversation.id, messageRepo, "No tengo internet"),
      });

      const supportCases = await caseRepo.listByConversation(conversation.id);
      expect(supportCases).toHaveLength(1);
      const supportCase = supportCases[0]!;
      expect(supportCase.status).toBe("WAITING_USER");
      const supportDepartment = await departmentRepo.findBySlug("support");
      expect(supportCase.departmentId).toBe(supportDepartment?.id);

      let conversationState = await conversationRepo.findById(conversation.id);
      expect(conversationState?.activeCaseId).toBe(supportCase.id);
      expect(whatsappSender.sent.length).toBeGreaterThanOrEqual(1);
      expect(whatsappSender.sent[0]!.body).not.toMatch(/^\s*\{/);

      // §13: responde cédula → avanza VALIDATE_CLIENT → CHECK_BALANCE → DIAGNOSTIC
      await useCase.execute({
        conversationId: conversation.id,
        correlationId: "corr-1b",
        messages: textMessages(conversation.id, messageRepo, "1"),
      });
      const supportAfterCedula = (await caseRepo.findById(supportCase.id))!.case;
      expect(supportAfterCedula.status).toBe("WAITING_USER");
      if (supportAfterCedula.context.workflowType === "SUPPORT_INTERNET") {
        expect(supportAfterCedula.context.data.client?.nationalId).toBe("1");
      }

      await useCase.execute({
        conversationId: conversation.id,
        correlationId: "corr-2",
        messages: textMessages(conversation.id, messageRepo, "¿Cuanto debo?"),
      });

      const supportAfterPause = (await caseRepo.findById(supportCase.id))!.case;
      expect(supportAfterPause.status).toBe("PAUSED");
      expect(supportAfterPause.context).toEqual(supportAfterCedula.context);

      const allCasesAfterStep2 = await caseRepo.listByConversation(conversation.id);
      const billingCase = allCasesAfterStep2.find((c) => c.workflowType === "BILLING_BALANCE");
      expect(billingCase).toBeDefined();
      expect(billingCase!.status).toBe("WAITING_USER");
      const billingDepartment = await departmentRepo.findBySlug("billing");
      expect(billingCase!.departmentId).toBe(billingDepartment?.id);

      conversationState = await conversationRepo.findById(conversation.id);
      expect(conversationState?.activeCaseId).toBe(billingCase!.id);

      await useCase.execute({
        conversationId: conversation.id,
        correlationId: "corr-3",
        messages: textMessages(conversation.id, messageRepo, "Sigo sin internet"),
      });

      const supportCasesAfterResume = (await caseRepo.listByConversation(conversation.id)).filter(
        (c) => c.workflowType === "SUPPORT_INTERNET",
      );
      expect(supportCasesAfterResume).toHaveLength(1);
      const resumedSupport = supportCasesAfterResume[0]!;
      expect(resumedSupport.id).toBe(supportCase.id);
      expect(resumedSupport.status).toBe("COMPLETED");
      if (resumedSupport.context.workflowType === "SUPPORT_INTERNET") {
        expect(resumedSupport.context.data.client?.nationalId).toBe("1");
        expect(resumedSupport.context.data.diagnostic?.status).toBe("RESOLVED");
      } else {
        throw new Error("contexto con workflowType inesperado");
      }
    },
  );

  it("una interpretacion UNCLEAR no crea caso y envia aclaracion de negocio", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      advanceCase,
      departmentResolver,
      arbitrationService,
      engine,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;
    const conversation = conversationRepo.createOpen();
    const interpretationProvider = new QueuedInterpretationProvider([
      { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0 },
    ]);
    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      interpretationProvider,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
      logger: silentLogger,
    });

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-1",
      messages: textMessages(conversation.id, messageRepo, "asdkjaslkd"),
    });

    expect(await caseRepo.listByConversation(conversation.id)).toHaveLength(0);
    const conversationAfter = await conversationRepo.findById(conversation.id);
    expect(conversationAfter?.activeCaseId).toBeNull();
    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body.length).toBeGreaterThan(10);
    expect(whatsappSender.sent[0]!.body).not.toMatch(/^\s*[\[{]/);
    const outbound = await messageRepo.listByConversation(conversation.id);
    expect(outbound.some((m) => m.author === "ai")).toBe(true);
  });
});
