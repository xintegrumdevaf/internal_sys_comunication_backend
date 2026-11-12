import { describe, expect, it } from "vitest";
import { ProcessBufferedMessagesUseCase } from "../../../src/core/modules/cases/application/use-cases/process-buffered-messages.use-case";
import { AdvanceCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { CaseArbitrationService } from "../../../src/core/modules/cases/application/services/case-arbitration.service";
import { DepartmentResolverService } from "../../../src/core/modules/cases/application/services/department-resolver.service";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import { billingBalanceWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/billing-balance.workflow";
import { salesWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/sales.workflow";
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
import type { EscalationService } from "../../../src/core/modules/escalation/application/services/escalation.service";

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

function buildScenario() {
  const caseRepo = new CaseRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const messageRepo = new MessageRepositoryFake();
  const whatsappSender = new WhatsAppSenderFake();
  const departmentRepo = new DepartmentRepositoryFake();
  departmentRepo.seed({ slug: "support", name: "Soporte tecnico" });
  departmentRepo.seed({ slug: "billing", name: "Facturacion" });

  const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
  const engine = new WorkflowEngine([
    supportInternetWorkflow,
    billingBalanceWorkflow,
    salesWorkflow,
  ]);
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

  it("error en el proveedor de interpretacion activa el fallback de error tecnico y no deja muerta la conversacion", async () => {
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
    const interpretationProvider: InterpretationPort = {
      interpretMessage: async () => {
        throw new Error("Ollama connection failed");
      },
    };
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
      correlationId: "corr-err-1",
      messages: textMessages(conversation.id, messageRepo, "quiero soporte"),
    });

    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toContain("Disculpa, tuvimos un inconveniente técnico al procesar tu mensaje.");
  });

  it("extrae la cedula de 10 digitos del historial de mensajes si falta en la interpretacion", async () => {
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
    
    // Seed message in history with a 10-digit number (Ecuadorian cédula format)
    messageRepo.seedText(conversation.id, "1724482722");

    const interpretationProvider = new QueuedInterpretationProvider([
      { type: "NEW_INTENT", intent: "support.internet", entities: {}, confidence: 0.9 },
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
      correlationId: "corr-hist-1",
      messages: textMessages(conversation.id, messageRepo, "soporte"),
    });

    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases).toHaveLength(1);
    // Since history had 1724482722, it got auto-extracted, VALIDATE_CLIENT succeeded, and case is in WAITING_USER (diagnostic/luz roja)
    expect(cases[0]!.status).toBe("WAITING_USER");
    if (cases[0]!.context.workflowType === "SUPPORT_INTERNET") {
      expect(cases[0]!.context.data.client?.nationalId).toBe("1724482722");
    }
  });

  it("responde de forma cálida y humana con el monto dinámico al recibir un comprobante de pago", async () => {
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
      { type: "NEW_INTENT", intent: "billing.record_payment", entities: { amount: 20.53 }, confidence: 0.95 },
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

    const imageMsg = messageRepo.seedText(conversation.id, "Buenos días envío el comprobante de pago de $20,53");
    imageMsg.type = "image";

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-receipt-1",
      messages: [imageMsg],
    });

    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toBe(
      "¡Recibido, gracias! 🙌 Estamos verificando tu comprobante de pago de $20,53 y te confirmamos por aquí mismo en cuanto quede listo. ¡Gracias por tu confianza!"
    );
  });

  it("no silencia el bot si el caso escalado previo ya expiro por inactividad (>24h) y atiende la nueva interaccion", async () => {
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

    // Crear un caso escalado de hace 4 días (como en la BD real)
    const oldCase = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    const storedCase = (await caseRepo.findById(oldCase.case.id))!.case;
    storedCase.status = "ESCALATED";
    storedCase.lastActivityAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

    const interpretationProvider = new QueuedInterpretationProvider([
      { type: "NEW_INTENT", intent: "support.internet", entities: {}, confidence: 0.95 },
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

    const newMsg = messageRepo.seedText(conversation.id, "Hola");

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-expired-escalation",
      messages: [newMsg],
    });

    // El bot no fue silenciado: atendió el mensaje y envió respuesta
    expect(whatsappSender.sent.length).toBeGreaterThan(0);
    // Y el caso viejo quedó en EXPIRED
    const refreshedOldCase = await caseRepo.findById(oldCase.case.id);
    expect(refreshedOldCase?.case.status).toBe("EXPIRED");
  });

  it("no responde la IA cuando un agente inició la conversación y el cliente contesta", async () => {
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

    const openCase = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    const storedCase = (await caseRepo.findById(openCase.case.id))!.case;
    storedCase.status = "HUMAN_ACTIVE";
    storedCase.assignedAgentId = "agent-adriana";
    storedCase.lastActivityAt = new Date(Date.now() - 30 * 60 * 60 * 1000);
    await caseRepo.setAutomationEnabled(openCase.case.id, true, { reason: "human_reply_missing" });

    messageRepo.seedText(
      conversation.id,
      "Buen dia, por favor me ayuda validando nuevamente el servicio de la tv",
      { author: "agent", direction: "outbound", agentId: "agent-adriana" },
    );
    const customerReply = messageRepo.seedText(conversation.id, "Buenas tardes no estoy en casa");

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      interpretationProvider: new QueuedInterpretationProvider([]),
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
      logger: silentLogger,
    });

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-agent-started",
      messages: [customerReply],
    });

    expect(whatsappSender.sent).toHaveLength(0);
    const refreshed = await caseRepo.findById(openCase.case.id);
    expect(refreshed?.case.status).toBe("HUMAN_ACTIVE");
  });

  it("activa el Circuit Breaker y escala a triage con MAX_CLARIFY_ATTEMPTS_EXCEEDED si el bot ya había pedido aclaración", async () => {
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

    // 1. Simular que el bot ya envió una aclaración previa
    messageRepo.seedText(
      conversation.id,
      "¡Hola! 👋 ¿En qué te puedo ayudar hoy? ¿Tienes algún inconveniente con tu internet, pagos, o prefieres hablar con un especialista?",
      {
        direction: "outbound",
        author: "ai",
        caption: JSON.stringify({ action: "CLARIFY" }),
      },
    );

    // 2. El cliente responde algo ambiguo que vuelve a dar UNCLEAR
    const interpretationProvider = new QueuedInterpretationProvider([
      { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0.2 },
    ]);

    let triageInput: any = null;
    const escalationService = {
      sendToTriage: async (input: any) => {
        triageInput = input;
        return {
          case: {} as any,
          escalation: {} as any,
          customerMessage: "Te estamos transfiriendo con un asesor humano.",
        };
      },
      escalateExistingCase: async () => ({ case: {} as any, escalation: {} as any, customerMessage: "" }),
    } as any;

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
      escalationService,
      logger: silentLogger,
    });

    const customerMsg = messageRepo.seedText(conversation.id, "No me funciona nada");

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-circuit-breaker-test",
      messages: [customerMsg],
    });

    // Se activó el circuit breaker hacia triage
    expect(triageInput).not.toBeNull();
    expect(triageInput.reason).toBe("MAX_CLARIFY_ATTEMPTS_EXCEEDED");
    expect(triageInput.conversationId).toBe(conversation.id);

    // Se envió la respuesta al cliente sin entrar en bucle de clarificación
    const lastSent = whatsappSender.sent[whatsappSender.sent.length - 1];
    expect(lastSent?.body).toBe("Te estamos transfiriendo con un asesor humano.");
  });

  it("no confunde una foto general o de televisión con un comprobante e interpreta correctamente la solicitud de soporte", async () => {
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
    } = scenario;

    const conversation = conversationRepo.createOpen();

    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "NEW_INTENT",
        intent: "support.internet",
        entities: { problemDescription: "internet lento" },
        confidence: 0.95,
      },
    ]);

    const fakeAi = new FakeAIProvider();
    fakeAi.extractReceiptImpl = async () => ({
      isReceipt: false,
      amount: undefined,
      reference: undefined,
      date: undefined,
      description: "foto de televisor encendido en habitación",
    });

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
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      logger: silentLogger,
    });

    const imgMsg = messageRepo.seedText(conversation.id, "", { type: "image", mediaId: "media-tv" });
    const textMsg1 = messageRepo.seedText(conversation.id, "Porfavor para que me ayude con el internet");
    const textMsg2 = messageRepo.seedText(conversation.id, "Está más lento que la otra vez");

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-non-receipt-img",
      messages: [imgMsg, textMsg1, textMsg2],
    });

    // 1. NO debe enviar el mensaje de verificación de pago
    for (const sent of whatsappSender.sent) {
      expect(sent.body).not.toContain("Estamos verificando tu pago");
    }

    // 2. Debe haber creado un caso de SUPPORT_INTERNET, NO de BILLING_BALANCE
    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.workflowType).toBe("SUPPORT_INTERNET");
  });

  it("reconoce comprobante de pago con foto y texto 'Pago realizado' derivando a Cartera y silenciando el bot", async () => {
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
    } = scenario;

    const conversation = conversationRepo.createOpen();

    let escalatedReason: string | null = null;
    const escalationService = {
      escalateExistingCase: async (input: { caseId: string; reason: string }) => {
        escalatedReason = input.reason;
        return { customerMessage: "" };
      },
      sendToTriage: async () => ({ customerMessage: "" }),
    } as unknown as EscalationService;

    const fakeAi = new FakeAIProvider();
    // Simulamos que el OCR visual no extrajo monto explícito, pero la foto vino con 'Pago realizado'
    fakeAi.extractReceiptImpl = async () => ({
      isReceipt: true,
      amount: undefined,
      reference: undefined,
      date: undefined,
      description: "depósito bancario",
    });

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      interpretationProvider: new QueuedInterpretationProvider([
        { type: "NEW_INTENT", intent: "billing.record_payment", entities: {}, confidence: 0.95 },
      ]),
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      escalationService,
      logger: silentLogger,
    });

    const textMsg1 = messageRepo.seedText(conversation.id, "Pago realizado");
    const imgMsg = messageRepo.seedText(conversation.id, "", { type: "image", mediaId: "media-receipt" });
    const textMsg2 = messageRepo.seedText(conversation.id, "Buenos dias");

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-payment-submission",
      messages: [textMsg1, imgMsg, textMsg2],
    });

    // 1. Debe haber enviado el mensaje fijo de confirmación de pago recibido
    const lastSent = whatsappSender.sent[whatsappSender.sent.length - 1];
    expect(lastSent?.body).toContain("¡Recibido, gracias! 🙌 Estamos verificando tu comprobante de pago");

    // 2. Debe haber creado el caso en BILLING_BALANCE
    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.workflowType).toBe("BILLING_BALANCE");

    // 3. Debe haberse escalado
    expect(escalatedReason).toContain("Comprobante de pago");

    // 4. La automatización del bot debe estar DESACTIVADA para que no responda con consultas de saldo
    const autoState = await caseRepo.getAutomationState(cases[0]!.id);
    expect(autoState?.enabled).toBe(false);
  });

  it("deriva a cartera una foto de comprobante aunque el cliente no escriba nada y la interpretación sea UNCLEAR", async () => {
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
    } = scenario;

    const conversation = conversationRepo.createOpen();
    let escalatedReason: string | null = null;
    const escalationService = {
      escalateExistingCase: async (input: { caseId: string; reason: string }) => {
        escalatedReason = input.reason;
        return { customerMessage: "" };
      },
      sendToTriage: async () => ({ customerMessage: "" }),
    } as unknown as EscalationService;

    const fakeAi = new FakeAIProvider();
    fakeAi.extractReceiptImpl = async () => ({
      isReceipt: true,
      amount: 21.55,
      reference: undefined,
      date: undefined,
      description: "comprobante de transferencia Banco Pichincha",
    });

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      interpretationProvider: new QueuedInterpretationProvider([
        { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0.2 },
      ]),
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      escalationService,
      logger: silentLogger,
    });

    const imgMsg = messageRepo.seedText(conversation.id, "", { type: "image", mediaId: "media-pichincha" });
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-receipt-image-only",
      messages: [imgMsg],
    });

    const lastSent = whatsappSender.sent[whatsappSender.sent.length - 1];
    expect(lastSent?.body).toContain("Estamos verificando tu comprobante de pago");
    expect(lastSent?.body).not.toContain("¿En qué te puedo ayudar");

    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.workflowType).toBe("BILLING_BALANCE");
    expect(escalatedReason).toContain("Comprobante de pago");
    const autoState = await caseRepo.getAutomationState(cases[0]!.id);
    expect(autoState?.enabled).toBe(false);
  });

  it("si el cliente envió una foto en los últimos 30 min y luego manda un punto (.) como bump, reconoce el comprobante y deriva a cartera", async () => {
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
    } = scenario;

    const conversation = conversationRepo.createOpen();
    let escalatedReason: string | null = null;
    const escalationService = {
      escalateExistingCase: async (input: { caseId: string; reason: string }) => {
        escalatedReason = input.reason;
        return { customerMessage: "" };
      },
      sendToTriage: async () => ({ customerMessage: "" }),
    } as unknown as EscalationService;

    const fakeAi = new FakeAIProvider();
    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      interpretationProvider: new QueuedInterpretationProvider([
        { type: "UNCLEAR", intent: "general.inquiry", entities: {}, confidence: 0.3 },
      ]),
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      escalationService,
      logger: silentLogger,
    });

    // Simulamos que el cliente envió una imagen previamente (hace 2 minutos)
    messageRepo.seedText(conversation.id, "", {
      type: "image",
      mediaId: "prior-media-1",
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
    });

    // Y ahora el cliente envía un punto (.) como toque de atención
    const dotMsg = messageRepo.seedText(conversation.id, ".");
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-dot-bump",
      messages: [dotMsg],
    });

    const lastSent = whatsappSender.sent[whatsappSender.sent.length - 1];
    expect(lastSent?.body).toContain("Estamos verificando tu comprobante de pago");
    expect(lastSent?.body).not.toContain("¡Hola! Buenos días");
    expect(escalatedReason).toContain("Comprobante de pago adjunto");
  });

  it("prioriza soporte técnico (support.internet) cuando el cliente reporta que no tiene internet aunque adjunte comprobante de pago", async () => {
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
      {
        type: "NEW_INTENT",
        intent: "support.internet",
        entities: { paymentReported: true, amount: 20 },
        confidence: 0.95,
      },
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

    const textMsg = messageRepo.seedText(conversation.id, "No tengo internet, pero ya pague en la mañana el servicio");
    const imgMsg = messageRepo.seedText(conversation.id, "", { type: "image", mediaId: "media-receipt-1" });

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-support-with-payment",
      messages: [textMsg, imgMsg],
    });

    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.workflowType).toBe("SUPPORT_INTERNET");
  });

  it("procesa y analiza archivos de video incorporando su descripción al contexto de interpretación", async () => {
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
    } = scenario;
    const conversation = conversationRepo.createOpen();

    let textReceivedByAi = "";
    const interpretationProvider = {
      interpretMessage: async (input: { text: string }) => {
        textReceivedByAi = input.text;
        return {
          type: "NEW_INTENT" as const,
          intent: "support.internet",
          entities: { answer: "luces rojas" },
          confidence: 0.95,
        };
      },
    };

    const fakeAi = new FakeAIProvider();
    fakeAi.extractReceiptImpl = async (_url, mime) => {
      expect(mime).toBe("video/mp4");
      return {
        isReceipt: false,
        description: "video de router con luces rojas en LOS",
      };
    };

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
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      logger: silentLogger,
    });

    const videoMsg = messageRepo.seedText(conversation.id, "Miren cómo está el router", {
      type: "video",
      mediaId: "video-router-1",
      mimeType: "video/mp4",
      caption: "Miren cómo está el router",
    });

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-video-analysis",
      messages: [videoMsg],
    });

    expect(textReceivedByAi).toContain("[Adjunto video: video de router con luces rojas en LOS]");
    expect(textReceivedByAi).toContain("Miren cómo está el router");
    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.workflowType).toBe("SUPPORT_INTERNET");
  });

  it("silencia el bot si el caso está asignado a un agente humano y el cliente vuelve a escribir", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;

    const conversation = conversationRepo.createOpen();
    const { case: existingCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-support",
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    // Simulamos que el caso fue asignado a un agente humano
    await caseRepo.setAssignedAgent(existingCase.id, "agent-adriana");
    await caseRepo.applyTransition({
      caseId: existingCase.id,
      expectedCaseVersion: 1,
      expectedWorkflowVersion: 1,
      status: "HUMAN_ACTIVE",
      context: existingCase.context,
      currentState: "HUMAN_DIRECT",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, existingCase.id);

    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "NEW_INTENT",
        intent: "support.internet",
        entities: {},
        confidence: 0.95,
      },
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

    const clientMsg = messageRepo.seedText(conversation.id, "Buenas tardes no estoy en casa");

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-human-assigned",
      messages: [clientMsg],
    });

    // El bot NO debe haber respondido porque el caso está asignado a un agente
    expect(whatsappSender.sent).toHaveLength(0);
    const autoState = await caseRepo.getAutomationState(existingCase.id);
    expect(autoState?.enabled).toBe(false);
  });

  it("permite que el bot responda si el caso previo fue completado o resuelto", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;

    const conversation = conversationRepo.createOpen();
    const { case: completedCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-support",
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "RESOLVED",
      expiresAt: null,
    });

    // Caso resuelto anteriormente
    await caseRepo.setAssignedAgent(completedCase.id, "agent-adriana");
    await caseRepo.applyTransition({
      caseId: completedCase.id,
      expectedCaseVersion: 1,
      expectedWorkflowVersion: 1,
      status: "COMPLETED",
      context: completedCase.context,
      currentState: "RESOLVED",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, null);

    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "NEW_INTENT",
        intent: "support.internet",
        entities: {},
        confidence: 0.95,
      },
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

    const newClientMsg = messageRepo.seedText(conversation.id, "Hola, se cayó mi internet de nuevo");

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-completed-case",
      messages: [newClientMsg],
    });

    // Al estar resuelto el caso anterior, el bot SÍ puede atender la nueva consulta
    expect(whatsappSender.sent.length).toBeGreaterThan(0);
  });

  it("si el cliente menciona pago pero no adjunta comprobante visual, no acusa recibo falso y solicita la foto o comprobante", async () => {
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
      { type: "NEW_INTENT", intent: "billing.record_payment", entities: {}, confidence: 0.95 },
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

    const textOnlyMsg = messageRepo.seedText(conversation.id, "ya pagué el servicio");

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-no-receipt-text",
      messages: [textOnlyMsg],
    });

    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toBe(
      "Para poder verificar y registrar tu pago en el sistema, por favor envíanos una foto o captura del comprobante de transferencia o depósito bancario."
    );
    expect(whatsappSender.sent[0]!.body).not.toContain("¡Recibido, gracias!");

    const convCases = await caseRepo.listByConversation(conversation.id);
    expect(convCases).toHaveLength(1);
    expect(convCases[0]!.status).toBe("WAITING_USER");
  });

  it("permite que el bot responda inmediatamente si el mensaje previo fue una plantilla o campaña (agentId: null)", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;

    const conversation = conversationRepo.createOpen();
    await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "agent",
      body: "📋 [Plantilla: recordatorio_pago_v1] Bienvenido a un nuevo mes...",
      agentId: null,
      caption: "template:recordatorio_pago_v1",
    });

    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "NEW_INTENT",
        intent: "billing.balance",
        entities: {},
        confidence: 0.95,
      },
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

    const newClientMsg = messageRepo.seedText(
      conversation.id,
      "Buenas tardes me ayuda con el valor a cancelar",
    );

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-template-reply",
      messages: [newClientMsg],
    });

    expect(whatsappSender.sent.length).toBeGreaterThan(0);
  });

  it("responde cordialmente con agradecimiento post-cierre sin crear casos nuevos cuando el cliente agradece o confirma servicio", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;
    const conversation = conversationRepo.createOpen();

    // 1. Caso previo completado de soporte técnico
    const { case: prevCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: { client: { nationalId: "0102030405", fullName: "Cliente" } } },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: prevCase.id,
      expectedCaseVersion: prevCase.version,
      expectedWorkflowVersion: 1,
      status: "COMPLETED",
      context: { ...prevCase.context, closeReason: "RESOLVED" },
      currentState: "COMPLETED",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, null);

    // 2. Cliente escribe minutos/horas después agradeciendo que ya le funcionó el internet
    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "CANCEL",
        intent: "general.inquiry",
        entities: { isClosing: true, isThankYou: true },
        confidence: 0.95,
      },
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

    const thankMsg = messageRepo.seedText(conversation.id, "muchas gracias amigo, ya me funcionó el internet");

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-thank-you-post-close",
      messages: [thankMsg],
    });

    // Verificaciones:
    // 1. Debe haber enviado una respuesta cordial reconociendo el soporte resuelto
    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toContain("¡Con mucho gusto!");
    expect(whatsappSender.sent[0]!.body).not.toContain("¿En qué te podemos ayudar hoy? Puedes consultarnos sobre nuestros planes");

    // 2. NO debe haber creado un nuevo caso en la base de datos
    const allCases = await caseRepo.listByConversation(conversation.id);
    expect(allCases).toHaveLength(1); // Sólo el caso original completado
    expect(allCases[0]!.status).toBe("COMPLETED");

    // 3. activeCaseId debe permanecer null
    const convAfter = await conversationRepo.findById(conversation.id);
    expect(convAfter?.activeCaseId).toBeNull();
  });

  it("reconoce modismos y erratas coloquiales (ej. 'muchas grasias ya valio el internet') como confirmación de servicio post-cierre", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;
    const conversation = conversationRepo.createOpen();

    const { case: prevCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: prevCase.id,
      expectedCaseVersion: prevCase.version,
      expectedWorkflowVersion: 1,
      status: "COMPLETED",
      context: { ...prevCase.context, closeReason: "RESOLVED" },
      currentState: "COMPLETED",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, null);

    // La IA analiza semánticamente el mensaje contextual y detecta agradecimiento / confirmación de servicio
    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "CANCEL",
        intent: "general.inquiry",
        entities: { isThankYou: true, serviceConfirmed: true, isClosing: true },
        confidence: 0.95,
      },
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

    const colloquialMsg = messageRepo.seedText(conversation.id, "muchas grasias ya valio el internet");

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-colloquial-thank-you",
      messages: [colloquialMsg],
    });

    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toContain("¡Con mucho gusto!");

    const allCases = await caseRepo.listByConversation(conversation.id);
    expect(allCases).toHaveLength(1);
    expect(allCases[0]!.status).toBe("COMPLETED");
  });

  it("evita bucle post-cierre cuando el cliente envía varios emojis 👍, stickers o confirmaciones repetidas tras cerrar el caso", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;

    const conversation = conversationRepo.createOpen({ status: "resolved" });

    const { case: prevCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "BILLING_BALANCE",
      departmentId: null,
      context: { workflowType: "BILLING_BALANCE", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: prevCase.id,
      expectedCaseVersion: prevCase.version,
      expectedWorkflowVersion: 1,
      status: "COMPLETED",
      context: { ...prevCase.context, closeReason: "RESOLVED" },
      currentState: "COMPLETED",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, null);

    // Agente humano confirmó pago y cerró caso
    await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "agent",
      body: "Tu pago ha sido registrado correctamente. ¡Muchas gracias!",
      status: "sent",
    });
    await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "system",
      body: "🔒 Caso completado por Aracely Novillo • Motivo: Resuelto",
      status: "sent",
    });

    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "CANCEL",
        intent: "general.inquiry",
        entities: { isThankYou: true, isClosing: true, isCourtesy: true },
        confidence: 0.95,
      },
      {
        type: "CANCEL",
        intent: "general.inquiry",
        entities: { isThankYou: true, isClosing: true, isCourtesy: true },
        confidence: 0.95,
      },
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

    // 1. Cliente envía primer 👍 -> NLU interpreta semánticamente y responde una sola vez de forma natural
    const thumb1 = messageRepo.seedText(conversation.id, "👍");
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-thumb-1",
      messages: [thumb1],
    });
    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toContain("¡Con mucho gusto!");

    // 2. Cliente envía segundo 👍 -> post-close ack ya enviado, silencio absoluto
    const thumb2 = messageRepo.seedText(conversation.id, "👍");
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-thumb-2",
      messages: [thumb2],
    });
    expect(whatsappSender.sent).toHaveLength(1);

    // 3. Cliente envía un sticker -> post-close ack ya enviado, silencio absoluto
    const stickerMsg = messageRepo.seedText(conversation.id, "[sticker]", { type: "sticker" });
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-sticker-3",
      messages: [stickerMsg],
    });
    expect(whatsappSender.sent).toHaveLength(1);

    // 4. Cliente envía "ok gracias" -> tampoco debe repetir la despedida en bucle
    const ackText = messageRepo.seedText(conversation.id, "ok gracias");
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-ack-4",
      messages: [ackText],
    });
    expect(whatsappSender.sent).toHaveLength(1);
  });

  it("interpreta semánticamente un sticker post-cierre en primera instancia y responde con despedida natural única", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;

    const conversation = conversationRepo.createOpen({ status: "resolved" });

    const { case: prevCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: prevCase.id,
      expectedCaseVersion: prevCase.version,
      expectedWorkflowVersion: 1,
      status: "COMPLETED",
      context: { ...prevCase.context, closeReason: "RESOLVED" },
      currentState: "COMPLETED",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, null);

    await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "system",
      body: "🔒 Caso completado por Aracely Novillo • Motivo: Resuelto",
      status: "sent",
    });

    let receivedTextInNLU = "";
    const interpretationProvider = {
      interpretMessage: async (input: { text: string }) => {
        receivedTextInNLU = input.text;
        return {
          type: "CANCEL" as const,
          intent: "general.inquiry",
          entities: { isClosing: true, isCourtesy: true, isThankYou: true },
          confidence: 0.95,
        };
      },
    } as any;

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

    const stickerMsg = messageRepo.seedText(conversation.id, "[sticker]", { type: "sticker" });
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-sticker-first",
      messages: [stickerMsg],
    });

    expect(receivedTextInNLU).toBe("[Sticker enviado por el cliente]");
    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toContain("¡Con mucho gusto!");

    // Sticker subsecuente -> silencio absoluto
    const stickerMsg2 = messageRepo.seedText(conversation.id, "[sticker]", { type: "sticker" });
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-sticker-second",
      messages: [stickerMsg2],
    });
    expect(whatsappSender.sent).toHaveLength(1);
  });

  it("cuando el cliente envía 'Gracias' y luego 'Ok Gracias' tras cerrar el caso, la IA despide una sola vez sin repetir plantilla ni bucle", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;

    const conversation = conversationRepo.createOpen({ status: "resolved" });

    const { case: prevCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "BILLING_BALANCE",
      departmentId: null,
      context: { workflowType: "BILLING_BALANCE", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: prevCase.id,
      expectedCaseVersion: prevCase.version,
      expectedWorkflowVersion: 1,
      status: "COMPLETED",
      context: { ...prevCase.context, closeReason: "RESOLVED" },
      currentState: "COMPLETED",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, null);

    // Mensaje previo del asesor confirmando el pago y cierre del caso
    await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "agent",
      body: "Tu pago ha sido registrado correctamente. ¡Muchas gracias!",
      status: "sent",
    });
    await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "system",
      body: "🔒 Caso completado por Aracely Novillo • Motivo: Resuelto",
      status: "sent",
    });

    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "CANCEL",
        intent: "general.inquiry",
        entities: { isThankYou: true, isClosing: true },
        confidence: 0.95,
      },
      {
        type: "CANCEL",
        intent: "general.inquiry",
        entities: { isThankYou: true, isClosing: true },
        confidence: 0.95,
      },
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

    // 1. Cliente envía 'Gracias' -> responde una sola vez de forma cordial y natural
    const msg1 = messageRepo.seedText(conversation.id, "Gracias");
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-gracias-1",
      messages: [msg1],
    });
    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toContain("¡Con mucho gusto!");
    expect(whatsappSender.sent[0]!.body).not.toContain("Tu pago quedó registrado correctamente");

    // 2. Cliente envía 'Ok Gracias' -> silencio absoluto, no repite el mensaje ni genera bucle
    const msg2 = messageRepo.seedText(conversation.id, "Ok Gracias");
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-ok-gracias-2",
      messages: [msg2],
    });
    expect(whatsappSender.sent).toHaveLength(1);
  });

  it("reconoce foto de comprobante con texto 'Me ayuda registrando el pago por favor' aunque el OCR falle, derivando a cartera", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
    } = scenario;

    const conversation = conversationRepo.createOpen();

    // extractReceiptData falla o devuelve vacío (simulando timeout u OCR no disponible)
    const extractReceiptData = {
      execute: async () => ({}),
    } as any;

    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "NEW_INTENT",
        intent: "billing.record_payment",
        entities: {},
        confidence: 0.95,
      },
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

    const imgMsg = messageRepo.seedText(
      conversation.id,
      "Bertha Mercedes Espin Buce\n1705193025\nMe ayuda registrando el pago por favor!",
      { type: "image", mediaId: "media-produbanco-receipt" }
    );

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-produbanco-receipt",
      messages: [imgMsg],
    });

    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toContain("¡Recibido, gracias!");
    expect(whatsappSender.sent[0]!.body).not.toContain("por favor envíanos una foto");

    const convCases = await caseRepo.listByConversation(conversation.id);
    expect(convCases).toHaveLength(1);
    expect(convCases[0]!.status).toBe("NEW");
  });

  it("activa el circuit breaker y no repite la solicitud de comprobante si el cliente responde sin adjuntar imagen", async () => {
    const scenario = buildScenario();
    const {
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver,
      arbitrationService,
      engine,
      advanceCase,
      composeReply,
      transcribeAudio,
      extractReceiptData,
    } = scenario;

    const conversation = conversationRepo.createOpen();

    // Caso previo en WAITING_USER_RECEIPT y el bot ya le había solicitado la foto
    const { case: activeCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "BILLING_BALANCE",
      departmentId: null,
      context: { workflowType: "BILLING_BALANCE", data: {} },
      initialState: "WAITING_USER_RECEIPT",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, activeCase.id);

    await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "ai",
      body: "Para poder verificar y registrar tu pago en el sistema, por favor envíanos una foto o captura del comprobante de transferencia o depósito bancario.",
      status: "sent",
    });

    const interpretationProvider = new QueuedInterpretationProvider([
      {
        type: "CONTINUE",
        intent: "billing.record_payment",
        entities: {},
        confidence: 0.95,
      },
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

    const clientMsg = messageRepo.seedText(conversation.id, "Aquí tiene el comprobante..");
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-circuit-breaker-receipt",
      messages: [clientMsg],
    });

    // Verificaciones:
    // 1. Debe responder derivando a un asesor humano, NUNCA repitiendo la misma plantilla
    expect(whatsappSender.sent).toHaveLength(1);
    expect(whatsappSender.sent[0]!.body).toContain("asesor");
    expect(whatsappSender.sent[0]!.body).not.toContain("por favor envíanos una foto o captura");
  });
});