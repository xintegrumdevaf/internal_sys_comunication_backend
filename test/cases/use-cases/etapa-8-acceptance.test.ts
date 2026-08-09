import { describe, expect, it } from "vitest";
import { AdvanceCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { ProcessBufferedMessagesUseCase } from "../../../src/core/modules/cases/application/use-cases/process-buffered-messages.use-case";
import { CaseArbitrationService } from "../../../src/core/modules/cases/application/services/case-arbitration.service";
import { DepartmentResolverService } from "../../../src/core/modules/cases/application/services/department-resolver.service";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import { billingBalanceWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/billing-balance.workflow";
import { salesPackagesWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/sales-packages.workflow";
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
import { resolveReplyTemplate } from "../../../src/core/modules/cases/application/services/resolve-reply-template";

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

function textMessages(
  conversationId: string,
  messageRepo: MessageRepositoryFake,
  body: string,
) {
  return [messageRepo.seedText(conversationId, body)];
}

describe("Etapa 8 — BILLING_BALANCE y SALES_PACKAGES end-to-end", () => {
  it("billing.balance: pide cedula, consulta saldo y responde con monto (no UNSUPPORTED)", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const whatsappSender = new WhatsAppSenderFake();
    const departmentRepo = new DepartmentRepositoryFake();
    departmentRepo.seed({ slug: "billing", name: "Facturacion" });

    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [
            { id: "1", name: "Ana", router: { sector: "pifo", olt_name: "o", pon: "1", serial: "S" } },
          ],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: true, debt: 45.5 } }),
    });

    const engine = new WorkflowEngine([
      supportInternetWorkflow,
      billingBalanceWorkflow,
      salesPackagesWorkflow,
    ]);
    const advanceCase = new AdvanceCaseUseCase({
      caseRepo,
      workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
      conversationRepo,
      engine,
      gateway,
      logger: silentLogger,
    });
    const fakeAi = new FakeAIProvider();
    fakeAi.composeImpl = async (input) => input.templateHint?.trim() || "ok";

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver: new DepartmentResolverService(departmentRepo),
      arbitrationService: new CaseArbitrationService(caseRepo, silentLogger),
      interpretationProvider: new QueuedInterpretationProvider([
        { type: "NEW_INTENT", intent: "billing.balance", entities: {}, confidence: 0.95 },
        {
          type: "ANSWER",
          intent: "billing.balance",
          entities: { nationalId: "16272728" },
          confidence: 0.99,
        },
      ]),
      engine,
      advanceCase,
      composeReply: new ComposeCustomerReplyUseCase(fakeAi),
      transcribeAudio: new TranscribeAudioUseCase(fakeAi),
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      logger: silentLogger,
    });

    const conversation = conversationRepo.createOpen();
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "e8-1",
      messages: textMessages(conversation.id, messageRepo, "¿cuánto debo?"),
    });

    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.workflowType).toBe("BILLING_BALANCE");
    expect(cases[0]!.status).toBe("WAITING_USER");
    const billingDept = await departmentRepo.findBySlug("billing");
    expect(cases[0]!.departmentId).toBe(billingDept?.id);
    expect(whatsappSender.sent[0]!.body).toMatch(/cédula|cedula/i);

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "e8-2",
      messages: textMessages(conversation.id, messageRepo, "16272728"),
    });

    const after = (await caseRepo.findById(cases[0]!.id))!.case;
    expect(after.status).toBe("COMPLETED");
    if (after.context.workflowType !== "BILLING_BALANCE") throw new Error("unreachable");
    expect(after.context.data.balance?.amount).toBe(45.5);

    const lastBody = whatsappSender.sent[whatsappSender.sent.length - 1]!.body;
    expect(lastBody).toMatch(/45\.50|45\.5/);
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(1);
    expect(gateway.actionsCalledFor("CHECK_BALANCE")).toBe(1);
  });

  it("billing.record_payment con entities completas llama RECORD_PAYMENT", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const whatsappSender = new WhatsAppSenderFake();
    const departmentRepo = new DepartmentRepositoryFake();
    departmentRepo.seed({ slug: "billing", name: "Facturacion" });

    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [
            { id: "1", name: "Ana", router: { sector: "pifo", olt_name: "o", pon: "1", serial: "S" } },
          ],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: true, debt: 20 } }),
      RECORD_PAYMENT: () => ({ success: true, result: { recorded: true } }),
    });

    const engine = new WorkflowEngine([billingBalanceWorkflow]);
    const advanceCase = new AdvanceCaseUseCase({
      caseRepo,
      workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
      conversationRepo,
      engine,
      gateway,
      logger: silentLogger,
    });
    const fakeAi = new FakeAIProvider();
    fakeAi.composeImpl = async (input) => input.templateHint?.trim() || "ok";

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver: new DepartmentResolverService(departmentRepo),
      arbitrationService: new CaseArbitrationService(caseRepo, silentLogger),
      interpretationProvider: new QueuedInterpretationProvider([
        {
          type: "NEW_INTENT",
          intent: "billing.record_payment",
          entities: { nationalId: "1", amount: 20, reference: "REF-99", date: "2026-08-08" },
          confidence: 0.95,
        },
      ]),
      engine,
      advanceCase,
      composeReply: new ComposeCustomerReplyUseCase(fakeAi),
      transcribeAudio: new TranscribeAudioUseCase(fakeAi),
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      logger: silentLogger,
    });

    const conversation = conversationRepo.createOpen();
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "e8-pay",
      messages: textMessages(conversation.id, messageRepo, "aqui va mi comprobante"),
    });

    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases[0]!.status).toBe("COMPLETED");
    expect(gateway.actionsCalledFor("RECORD_PAYMENT")).toBe(1);
    const lastBody = whatsappSender.sent[whatsappSender.sent.length - 1]!.body;
    expect(lastBody.toLowerCase()).toMatch(/pago|registr/);
  });

  it("sales.packages crea caso en dept sales y completa con oferta", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const whatsappSender = new WhatsAppSenderFake();
    const departmentRepo = new DepartmentRepositoryFake();
    departmentRepo.seed({ slug: "sales", name: "Ventas" });

    const gateway = new N8nGatewayFake({
      QUERY_KNOWLEDGE_BASE: () => ({
        success: true,
        result: {
          found: true,
          answer: "Plan Fibra 500 Mbps a $29.99 al mes.",
          planId: "f500",
          price: 29.99,
          speed: "500 Mbps",
        },
      }),
    });

    const engine = new WorkflowEngine([salesPackagesWorkflow]);
    const advanceCase = new AdvanceCaseUseCase({
      caseRepo,
      workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
      conversationRepo,
      engine,
      gateway,
      logger: silentLogger,
    });
    const fakeAi = new FakeAIProvider();
    fakeAi.composeImpl = async (input) => input.templateHint?.trim() || "ok";

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver: new DepartmentResolverService(departmentRepo),
      arbitrationService: new CaseArbitrationService(caseRepo, silentLogger),
      interpretationProvider: new QueuedInterpretationProvider([
        {
          type: "NEW_INTENT",
          intent: "sales.packages",
          entities: { requestedSpeed: "500 Mbps" },
          confidence: 0.9,
        },
      ]),
      engine,
      advanceCase,
      composeReply: new ComposeCustomerReplyUseCase(fakeAi),
      transcribeAudio: new TranscribeAudioUseCase(fakeAi),
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      logger: silentLogger,
    });

    const conversation = conversationRepo.createOpen();
    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "e8-sales",
      messages: textMessages(conversation.id, messageRepo, "qué planes de 500 megas tienen?"),
    });

    const cases = await caseRepo.listByConversation(conversation.id);
    expect(cases[0]!.workflowType).toBe("SALES_PACKAGES");
    expect(cases[0]!.status).toBe("COMPLETED");
    const salesDept = await departmentRepo.findBySlug("sales");
    expect(cases[0]!.departmentId).toBe(salesDept?.id);
    expect(gateway.actionsCalledFor("QUERY_KNOWLEDGE_BASE")).toBe(1);
    expect(whatsappSender.sent[0]!.body).toMatch(/500/);
  });

  it("resolveReplyTemplate BILLING incluye debt formateado", () => {
    const resolved = resolveReplyTemplate({
      definition: billingBalanceWorkflow,
      outcome: {
        type: "COMPLETED",
        context: {
          workflowType: "BILLING_BALANCE",
          data: { purpose: "balance", balance: { hasDebt: true, amount: 45.5 } },
        },
      },
      context: {
        workflowType: "BILLING_BALANCE",
        data: { purpose: "balance", balance: { hasDebt: true, amount: 45.5 } },
      },
    });
    expect(resolved.action).toBe("RESPOND_BALANCE");
    expect(resolved.resultVars.debt).toBe("45.50");
    expect(resolved.templateHint).toContain("{{debt}}");
  });
});
