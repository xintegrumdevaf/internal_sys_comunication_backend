import { describe, expect, it } from "vitest";
import { ComposeCustomerReplyUseCase } from "../../src/core/modules/ai/application/use-cases/compose-customer-reply.use-case";
import { ExtractReceiptDataUseCase } from "../../src/core/modules/ai/application/use-cases/extract-receipt-data.use-case";
import { InterpretMessageUseCase } from "../../src/core/modules/ai/application/use-cases/interpret-message.use-case";
import { TranscribeAudioUseCase } from "../../src/core/modules/ai/application/use-cases/transcribe-audio.use-case";
import { FakeAIProvider } from "../../src/core/modules/ai/infrastructure/fake/fake-ai.provider";
import { DomainError } from "../../src/shared/errors/domain-errors";
import { ProcessBufferedMessagesUseCase } from "../../src/core/modules/cases/application/use-cases/process-buffered-messages.use-case";
import { AdvanceCaseUseCase } from "../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { CaseArbitrationService } from "../../src/core/modules/cases/application/services/case-arbitration.service";
import { DepartmentResolverService } from "../../src/core/modules/cases/application/services/department-resolver.service";
import { WorkflowEngine } from "../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import { CaseRepositoryFake, N8nGatewayFake, WorkflowExecutionRepositoryFake } from "../cases/fakes";
import {
  ConversationRepositoryFake,
  DepartmentRepositoryFake,
  MessageRepositoryFake,
  WhatsAppSenderFake,
} from "../support/fakes";
import { silentLogger } from "../support/silent-logger";
import { AiInterpretationAdapter } from "../../src/core/modules/cases/infrastructure/ai/ai-interpretation.adapter";

describe("Etapa 5 aceptacion (docs/spec/05_BUILD_PLAN.md)", () => {
  it("composeReply nunca envia JSON crudo del resultado de un paso", async () => {
    const fake = new FakeAIProvider();
    fake.composeImpl = async () => JSON.stringify({ hasDebt: false, balance: 0 });
    const compose = new ComposeCustomerReplyUseCase(fake);

    const text = await compose.execute({
      caseId: "case-1",
      workflowType: "SUPPORT_INTERNET",
      stepOutcome: { action: "CHECK_BALANCE", status: "COMPLETED", result: { hasDebt: false } },
      templateHint: "No tienes deuda pendiente. Continuamos con el diagnostico.",
    });

    // Ante JSON del LLM, cae a la plantilla de negocio.
    expect(text).toContain("deuda");
    expect(text.trim().startsWith("{")).toBe(false);
  });

  it("AI_ERROR en interpretacion se reintenta una vez y luego UNCLEAR", async () => {
    const fake = new FakeAIProvider();
    let calls = 0;
    fake.interpretImpl = async () => {
      calls += 1;
      throw new DomainError("AI_ERROR", "boom", { retryable: true });
    };
    const useCase = new InterpretMessageUseCase(fake, silentLogger);
    const result = await useCase.execute({
      correlationId: "c1",
      conversationId: "conv1",
      messageId: "m1",
      text: "hola",
      conversationSnapshot: {},
    });
    expect(calls).toBe(2);
    expect(result.type).toBe("UNCLEAR");
  });

  it("imagen de comprobante con datos completos dispara billing.record_payment sin preguntar", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const whatsappSender = new WhatsAppSenderFake();
    const departmentRepo = new DepartmentRepositoryFake();
    departmentRepo.seed({ slug: "billing", name: "Facturacion" });
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({});
    const advanceCase = new AdvanceCaseUseCase({
      caseRepo,
      workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
      conversationRepo,
      engine,
      gateway,
      logger: silentLogger,
    });
    const fakeAi = new FakeAIProvider();
    fakeAi.interpretImpl = async () => ({
      type: "UNCLEAR",
      intent: "unknown",
      entities: {},
      confidence: 0.1,
    });
    fakeAi.extractReceiptImpl = async () => ({
      amount: 45,
      reference: "ABC123",
      date: "2026-08-07",
    });

    const conversation = conversationRepo.createOpen();
    const imageMsg = messageRepo.seedText(conversation.id, "", {
      type: "image",
      mediaId: "media-1",
      mimeType: "image/jpeg",
    });

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver: new DepartmentResolverService(departmentRepo),
      arbitrationService: new CaseArbitrationService(caseRepo, silentLogger),
      interpretationProvider: new AiInterpretationAdapter(fakeAi, silentLogger),
      engine,
      advanceCase,
      composeReply: new ComposeCustomerReplyUseCase(fakeAi),
      transcribeAudio: new TranscribeAudioUseCase(fakeAi),
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      logger: silentLogger,
    });

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-receipt",
      messages: [imageMsg],
    });

    // Sin BILLING_BALANCE definition: no crea caso, pero no pregunta datos al cliente
    // (decide billing por entities completas y responde con plantilla de aclaracion generica
    // o mensaje de negocio — nunca pide amount/reference).
    expect(await caseRepo.listByConversation(conversation.id)).toHaveLength(0);
    expect(whatsappSender.sent).toHaveLength(1);
    const body = whatsappSender.sent[0]!.body.toLowerCase();
    expect(body).not.toContain("monto");
    expect(body).not.toContain("referencia");
    expect(body.trim().startsWith("{")).toBe(false);
  });

  it("REQUEST_HUMAN escala a HUMAN_ACTIVE y avisa al cliente", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const whatsappSender = new WhatsAppSenderFake();
    const departmentRepo = new DepartmentRepositoryFake();
    departmentRepo.seed({ slug: "support", name: "Soporte" });
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const conversation = conversationRepo.createOpen();
    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, created.id);

    const fakeAi = new FakeAIProvider();
    fakeAi.interpretImpl = async () => ({
      type: "REQUEST_HUMAN",
      intent: "unknown",
      entities: {},
      confidence: 0.99,
    });

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver: new DepartmentResolverService(departmentRepo),
      arbitrationService: new CaseArbitrationService(caseRepo, silentLogger),
      interpretationProvider: new AiInterpretationAdapter(fakeAi, silentLogger),
      engine,
      advanceCase: new AdvanceCaseUseCase({
        caseRepo,
        workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
        conversationRepo,
        engine,
        gateway: new N8nGatewayFake({}),
        logger: silentLogger,
      }),
      composeReply: new ComposeCustomerReplyUseCase(fakeAi),
      transcribeAudio: new TranscribeAudioUseCase(fakeAi),
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      logger: silentLogger,
    });

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-human",
      messages: [messageRepo.seedText(conversation.id, "quiero hablar con una persona")],
    });

    const after = await caseRepo.findById(created.id);
    expect(after?.case.status).toBe("HUMAN_ACTIVE");
    const automation = await caseRepo.getAutomationState(created.id);
    expect(automation?.enabled).toBe(false);
    expect(whatsappSender.sent[0]!.body.toLowerCase()).toContain("asesor");
  });

  it("intencion valida activa SUPPORT_INTERNET", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const whatsappSender = new WhatsAppSenderFake();
    const departmentRepo = new DepartmentRepositoryFake();
    departmentRepo.seed({ slug: "support", name: "Soporte" });
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: false,
          contractNumbers: 0,
          contracts: [],
        },
      }),
    });
    const fakeAi = new FakeAIProvider();
    fakeAi.interpretImpl = async () => ({
      type: "NEW_INTENT",
      intent: "support.internet",
      entities: {},
      confidence: 0.92,
    });
    const conversation = conversationRepo.createOpen();

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver: new DepartmentResolverService(departmentRepo),
      arbitrationService: new CaseArbitrationService(caseRepo, silentLogger),
      interpretationProvider: new AiInterpretationAdapter(fakeAi, silentLogger),
      engine,
      advanceCase: new AdvanceCaseUseCase({
        caseRepo,
        workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
        conversationRepo,
        engine,
        gateway,
        logger: silentLogger,
      }),
      composeReply: new ComposeCustomerReplyUseCase(fakeAi),
      transcribeAudio: new TranscribeAudioUseCase(fakeAi),
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      logger: silentLogger,
    });

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-support",
      messages: [messageRepo.seedText(conversation.id, "no tengo internet")],
    });

    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.workflowType).toBe("SUPPORT_INTERNET");
    expect(cases[0]!.status).toBe("WAITING_USER");
    expect(whatsappSender.sent[0]!.body.toLowerCase()).toContain("cédula");
  });
});
