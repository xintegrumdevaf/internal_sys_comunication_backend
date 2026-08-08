import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../domain/case.entity";
import { emptyContextFor } from "../../domain/contexts/case-context";
import type { CaseContext } from "../../domain/contexts/case-context";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";
import type { WhatsAppSenderPort } from "../../../conversations/application/ports/whatsapp-sender.port";
import type { Message } from "../../../conversations/domain/message.entity";
import type { ComposeCustomerReplyUseCase } from "../../../ai/application/use-cases/compose-customer-reply.use-case";
import type { ExtractReceiptDataUseCase } from "../../../ai/application/use-cases/extract-receipt-data.use-case";
import type { TranscribeAudioUseCase } from "../../../ai/application/use-cases/transcribe-audio.use-case";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { InterpretationPort } from "../ports/interpretation.port";
import { CaseArbitrationService } from "../services/case-arbitration.service";
import { DepartmentResolverService } from "../services/department-resolver.service";
import { resolveReplyTemplate } from "../services/resolve-reply-template";
import { WorkflowEngine } from "../engine/workflow-engine";
import { AdvanceCaseUseCase } from "./advance-case.use-case";

export type ProcessBufferedMessagesDeps = {
  caseRepo: CaseRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  messageRepo: MessageRepositoryPort;
  whatsappSender: WhatsAppSenderPort;
  departmentResolver: DepartmentResolverService;
  arbitrationService: CaseArbitrationService;
  interpretationProvider: InterpretationPort;
  engine: WorkflowEngine;
  advanceCase: AdvanceCaseUseCase;
  composeReply: ComposeCustomerReplyUseCase;
  transcribeAudio: TranscribeAudioUseCase;
  extractReceiptData: ExtractReceiptDataUseCase;
  logger: Logger;
};

export type ProcessBufferedMessagesInput = {
  conversationId: string;
  correlationId: string;
  /** Mensajes del lote del buffer (orden cronologico). */
  messages: Message[];
};

/**
 * Consumidor del flush del buffer/debounce (docs/spec/02_STATE_MACHINE.md §12 +
 * docs/spec/03_API_CONTRACT.md §A.1): media → interpret → arbitraje → avance →
 * composeReply → WhatsApp.
 */
export class ProcessBufferedMessagesUseCase {
  constructor(private readonly deps: ProcessBufferedMessagesDeps) {}

  async execute(input: ProcessBufferedMessagesInput): Promise<void> {
    const { conversationId, correlationId, messages } = input;
    const log = this.deps.logger.child({ correlationId, conversationId });

    const { text, receiptEntities, primaryMessageId } = await this.prepareText(messages, log);
    const activeAggregate = await this.deps.caseRepo.findActiveByConversation(conversationId);

    let interpretation = await this.deps.interpretationProvider.interpretMessage({
      correlationId,
      conversationId,
      messageId: primaryMessageId,
      text,
      activeCase: activeAggregate ? { workflowType: activeAggregate.case.workflowType } : null,
    });

    // Comprobante completo → billing.record_payment sin preguntar (aceptacion Etapa 5).
    if (hasCompleteReceipt(receiptEntities)) {
      interpretation = {
        type: "NEW_INTENT",
        intent: "billing.record_payment",
        entities: { ...interpretation.entities, ...receiptEntities },
        confidence: Math.max(interpretation.confidence, 0.95),
      };
    }

    log.info(
      {
        textLength: text.length,
        interpretationType: interpretation.type,
        intent: interpretation.intent,
        confidence: interpretation.confidence,
        activeWorkflowType: activeAggregate?.case.workflowType ?? null,
      },
      "unidad de trabajo interpretada",
    );

    const decision = await this.deps.arbitrationService.decide({ conversationId, interpretation });
    log.info({ decision: decision.action }, "arbitraje de caso decidido");

    if (decision.action === "CLARIFY") {
      await this.sendCustomerReply({
        conversationId,
        correlationId,
        caseId: activeAggregate?.case.id ?? "none",
        workflowType: activeAggregate?.case.workflowType ?? "UNCLASSIFIED",
        decision: "CLARIFY",
        log,
      });
      return;
    }

    if (decision.action === "REQUEST_HUMAN") {
      if (decision.caseId) {
        await this.escalateToHuman(decision.caseId, log);
      }
      await this.sendCustomerReply({
        conversationId,
        correlationId,
        caseId: decision.caseId ?? "none",
        workflowType: activeAggregate?.case.workflowType ?? "UNCLASSIFIED",
        decision: "REQUEST_HUMAN",
        log,
      });
      return;
    }

    if (decision.action === "CONTINUE_ACTIVE") {
      const advanced = await this.deps.advanceCase.execute({
        caseId: decision.caseId,
        correlationId,
        text,
      });
      await this.sendCustomerReply({
        conversationId,
        correlationId,
        caseId: advanced.case.id,
        workflowType: advanced.case.workflowType,
        outcome: advanced.outcome,
        context: advanced.case.context,
        log,
      });
      return;
    }

    // ACTIVATE
    if (decision.pauseCaseId) {
      await this.pauseCase(decision.pauseCaseId, log);
    }

    // Si el workflow no esta registrado (ej. BILLING_BALANCE Etapa 8), no romper:
    // la decision de negocio ya quedo (entities/intent); informar al cliente.
    if (!decision.resumeCaseId && !this.deps.engine.getDefinition(decision.workflowType)) {
      log.warn({ workflowType: decision.workflowType }, "workflow_type sin definicion; no se avanza el motor");
      await this.sendCustomerReply({
        conversationId,
        correlationId,
        caseId: "none",
        workflowType: decision.workflowType,
        decision: "CLARIFY",
        log,
      });
      return;
    }

    const targetCaseId =
      decision.resumeCaseId ?? (await this.createCase(conversationId, decision.workflowType, log)).id;
    if (decision.resumeCaseId) {
      log.info({ caseId: targetCaseId }, "caso pausado reanudado sin reiniciar el workflow");
      await this.deps.caseRepo.appendEvent(targetCaseId, "CASE_RESUMED", {});
    }

    await this.deps.conversationRepo.setActiveCaseId(conversationId, targetCaseId);
    const advanced = await this.deps.advanceCase.execute({
      caseId: targetCaseId,
      correlationId,
      text,
    });
    await this.sendCustomerReply({
      conversationId,
      correlationId,
      caseId: advanced.case.id,
      workflowType: advanced.case.workflowType,
      outcome: advanced.outcome,
      context: advanced.case.context,
      log,
    });
  }

  private async prepareText(
    messages: Message[],
    log: Logger,
  ): Promise<{
    text: string;
    receiptEntities: Record<string, unknown>;
    primaryMessageId: string;
  }> {
    const parts: string[] = [];
    const receiptEntities: Record<string, unknown> = {};
    const primaryMessageId = messages[0]?.id ?? "unknown";

    for (const message of messages) {
      const type = message.type.toLowerCase();
      if (type === "audio" || type === "voice") {
        try {
          const mediaUrl = message.mediaId ?? "";
          const { transcript } = await this.deps.transcribeAudio.execute(
            mediaUrl,
            message.mimeType ?? "audio/ogg",
          );
          if (transcript.trim()) parts.push(transcript.trim());
        } catch (error) {
          log.warn(
            { messageId: message.id, err: error instanceof Error ? error.message : String(error) },
            "fallo transcribeAudio; se ignora el audio del lote",
          );
        }
        continue;
      }

      if (type === "image") {
        try {
          const mediaUrl = message.mediaId ?? "";
          const receipt = await this.deps.extractReceiptData.execute(
            mediaUrl,
            message.mimeType ?? "image/jpeg",
          );
          Object.assign(receiptEntities, receipt);
          if (message.caption) parts.push(message.caption);
          else if (message.body) parts.push(message.body);
        } catch (error) {
          log.warn(
            { messageId: message.id, err: error instanceof Error ? error.message : String(error) },
            "fallo extractReceiptData; se usa caption/body si hay",
          );
          if (message.body) parts.push(message.body);
        }
        continue;
      }

      if (message.body.trim()) parts.push(message.body.trim());
    }

    return { text: parts.join("\n"), receiptEntities, primaryMessageId };
  }

  private async sendCustomerReply(input: {
    conversationId: string;
    correlationId: string;
    caseId: string;
    workflowType: string;
    outcome?: Parameters<typeof resolveReplyTemplate>[0]["outcome"];
    context?: CaseContext;
    decision?: "CLARIFY" | "REQUEST_HUMAN";
    log: Logger;
  }): Promise<void> {
    const definition = this.deps.engine.getDefinition(input.workflowType);
    const resolved = resolveReplyTemplate({
      definition,
      outcome: input.outcome,
      decision: input.decision,
      context: input.context,
    });

    const body = await this.deps.composeReply.execute({
      caseId: input.caseId,
      workflowType: input.workflowType,
      stepOutcome: {
        action: resolved.action,
        status: resolved.status as "COMPLETED" | "FAILED" | "WAITING_USER" | "ESCALATED" | "ACTIVE" | "CLARIFY" | "REQUEST_HUMAN",
        result: resolved.resultVars,
      },
      templateHint: resolved.templateHint,
    });

    const conversation = await this.deps.conversationRepo.findById(input.conversationId);
    if (!conversation) {
      input.log.warn("conversacion no encontrada al enviar reply de IA");
      return;
    }

    let externalId: string | null = null;
    try {
      const sent = await this.deps.whatsappSender.sendText(conversation.waPhone, body);
      externalId = sent.externalId;
    } catch (error) {
      input.log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "fallo al enviar reply de IA por WhatsApp; se persiste igual",
      );
    }

    await this.deps.messageRepo.insertOutbound({
      conversationId: input.conversationId,
      author: "ai",
      body,
      externalId,
    });
    input.log.info({ bodyPreview: body.slice(0, 80) }, "respuesta de IA enviada al cliente");
  }

  private async escalateToHuman(caseId: string, log: Logger): Promise<void> {
    const aggregate = await this.deps.caseRepo.findById(caseId);
    if (!aggregate) return;
    await this.deps.caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "HUMAN_ACTIVE",
      context: aggregate.case.context,
      currentState: aggregate.workflowInstance.currentState,
      expiresAt: null,
    });
    await this.deps.caseRepo.setAutomationEnabled(aggregate.case.id, false, {
      reason: "REQUEST_HUMAN",
    });
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_ESCALATED", { reason: "REQUEST_HUMAN" });
    log.info({ caseId }, "caso pasado a HUMAN_ACTIVE por REQUEST_HUMAN");
  }

  private async pauseCase(caseId: string, log: Logger): Promise<void> {
    const aggregate = await this.deps.caseRepo.findById(caseId);
    if (!aggregate) {
      return;
    }
    await this.deps.caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "PAUSED",
      context: aggregate.case.context,
      currentState: aggregate.workflowInstance.currentState,
      expiresAt: aggregate.case.expiresAt,
    });
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_PAUSED", {});
    log.info({ caseId: aggregate.case.id, workflowType: aggregate.case.workflowType }, "caso pausado por cambio de tema");
  }

  private async createCase(conversationId: string, workflowType: string, log: Logger): Promise<Case> {
    const definition = this.deps.engine.getDefinition(workflowType);
    if (!definition) {
      // Sin definicion (Etapa 8): crear placeholder no aplica; el caller evita advance.
      throw new DomainError("UNSUPPORTED", `No hay WorkflowDefinition registrada para '${workflowType}'`);
    }

    const departmentId = await this.deps.departmentResolver.resolveDepartmentId(workflowType);
    const expiresAt = new Date(Date.now() + definition.expirationHours * 60 * 60 * 1000);

    const aggregate = await this.deps.caseRepo.create({
      conversationId,
      workflowType,
      departmentId,
      context: emptyContextFor(workflowType as CaseContext["workflowType"]),
      initialState: definition.initialState,
      expiresAt,
    });
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_CREATED", { workflowType });
    log.info({ caseId: aggregate.case.id, workflowType, departmentId }, "caso nuevo creado");
    return aggregate.case;
  }
}

function hasCompleteReceipt(entities: Record<string, unknown>): boolean {
  return (
    entities.amount !== undefined &&
    entities.reference !== undefined &&
    entities.date !== undefined
  );
}
