import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import { TERMINAL_CASE_STATUSES, type Case } from "../../domain/case.entity";
import { emptyContextFor, type CaseContext } from "../../domain/contexts/case-context";
import type { BillingBalanceContext } from "../../domain/contexts/billing-balance.context";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";
import type { WhatsAppSenderPort } from "../../../conversations/application/ports/whatsapp-sender.port";
import type { Message } from "../../../conversations/domain/message.entity";
import type { ComposeCustomerReplyUseCase } from "../../../ai/application/use-cases/compose-customer-reply.use-case";
import type { ExtractReceiptDataUseCase } from "../../../ai/application/use-cases/extract-receipt-data.use-case";
import type { TranscribeAudioUseCase } from "../../../ai/application/use-cases/transcribe-audio.use-case";
import type { EscalationService } from "../../../escalation/application/services/escalation.service";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { InterpretationPort } from "../ports/interpretation.port";
import { type CaseArbitrationService } from "../services/case-arbitration.service";
import { type DepartmentResolverService } from "../services/department-resolver.service";
import { resolveReplyTemplate } from "../services/resolve-reply-template";
import { type WorkflowEngine } from "../engine/workflow-engine";
import { type AdvanceCaseUseCase } from "./advance-case.use-case";
import { normalizeNationalId } from "../../../customers/domain/national-id";
import type { DepartmentRoutingService } from "../../../departments/application/services/department-routing.service";
import { ExpirationService } from "../services/expiration.service";
import { checkCustomerGuardrails } from "../../domain/guardrails";
import type { ConversationIdentityPort } from "../../../customers/application/ports/conversation-identity.port";

export type ProcessBufferedMessagesDeps = {
  caseRepo: CaseRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  messageRepo: MessageRepositoryPort;
  whatsappSender: WhatsAppSenderPort;
  departmentResolver: DepartmentResolverService;
  routingService?: DepartmentRoutingService;
  arbitrationService: CaseArbitrationService;
  interpretationProvider: InterpretationPort;
  engine: WorkflowEngine;
  advanceCase: AdvanceCaseUseCase;
  composeReply: ComposeCustomerReplyUseCase;
  transcribeAudio: TranscribeAudioUseCase;
  extractReceiptData: ExtractReceiptDataUseCase;
  logger: Logger;
  identity?: ConversationIdentityPort;
  escalationService?: EscalationService;
  broadcaster?: RealtimeBroadcaster;
  expirationService?: ExpirationService;
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

    try {
      const conversation = await this.deps.conversationRepo.findById(conversationId);
      const cases = await this.deps.caseRepo.listByConversation(conversationId);
      const openCases = cases.filter((c) => !TERMINAL_CASE_STATUSES.includes(c.status));

      let targetCase: Case | null = null;
      if (conversation?.activeCaseId) {
        const activeMatch = openCases.find((c) => c.id === conversation.activeCaseId);
        if (activeMatch) targetCase = activeMatch;
      }
      if (!targetCase) {
        targetCase =
          openCases.find((c) => Boolean(c.assignedAgentId) || c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED") ??
          openCases.find((c) => c.status === "ACTIVE" || c.status === "WAITING_USER") ??
          openCases.find((c) => c.status === "NEW") ??
          null;
      }

      if (targetCase?.context.schedulingMetadata?.scheduledAt) {
        log.info(
          {
            caseId: targetCase.id,
            scheduledAt: targetCase.context.schedulingMetadata.scheduledAt,
          },
          "conversación en espera de retoma humana: silenciando bot",
        );
        await this.deps.caseRepo.setAutomationEnabled(targetCase.id, false, {
          reason: "scheduled_human_followup",
        });
        return;
      }

      const priorMessages = await this.deps.messageRepo.listByConversation(conversationId, {
        limit: 15,
      });
      const inboundIds = new Set(messages.map((message) => message.id));
      const lastPrior = [...priorMessages]
        .reverse()
        .find((message) => !inboundIds.has(message.id) && message.author !== "system");
      const isRealHumanAgent = lastPrior?.author === "agent" && Boolean(lastPrior?.agentId);
      const isCaseActive = Boolean(targetCase && !TERMINAL_CASE_STATUSES.includes(targetCase.status));
      const humanIntervenedRecently =
        isRealHumanAgent &&
        isCaseActive &&
        Date.now() - lastPrior.createdAt.getTime() < 24 * 60 * 60 * 1000;

      if (targetCase) {
        // docs/spec/02_STATE_MACHINE.md §8: Expiración perezosa.
        // Si el caso candidato ya venció por inactividad (>24h), no bloquea abrir un caso nuevo ni silencia el bot.
        // Un agente que escribió en las últimas 24h mantiene la conversación: no se vence ni responde la IA.
        const isCaseExpired = this.deps.expirationService
          ? this.deps.expirationService.isExpired(targetCase)
          : (targetCase.expiresAt !== null && targetCase.expiresAt.getTime() <= Date.now()) ||
            (targetCase.expiresAt === null && Date.now() - targetCase.lastActivityAt.getTime() >= 24 * 60 * 60 * 1000);

        if (isCaseExpired && humanIntervenedRecently) {
          log.info(
            { caseId: targetCase.id, messageId: lastPrior?.id, agentId: lastPrior?.agentId },
            "el agente humano inició la conversación en caso activo: silenciando bot",
          );
          return;
        }

        if (isCaseExpired) {
          log.info(
            { caseId: targetCase.id, status: targetCase.status, lastActivityAt: targetCase.lastActivityAt },
            "Caso previo vencido por inactividad: descartado para permitir nueva atención",
          );
          const expService =
            this.deps.expirationService ??
            new ExpirationService(this.deps.caseRepo, this.deps.logger);
          await expService.expireCase(targetCase.id).catch((err) => {
            log.warn({ err, caseId: targetCase?.id }, "fallo al expirar caso perezosamente");
          });
          targetCase = null;
        }
      }

      if (targetCase) {
        const autoState = await this.deps.caseRepo.getAutomationState(targetCase.id);
        const hasAssignedAgent = Boolean(targetCase.assignedAgentId);
        const isHumanStatus = targetCase.status === "HUMAN_ACTIVE" || targetCase.status === "ESCALATED";

        // Regla no negociable: si el asistente de IA deriva a un agente o ya está asignado,
        // el asistente de IA se desactiva y no puede responder a la conversación a menos que
        // el agente humano lo habilite expresamente (reactivate-automation) o que el caso se resuelva.
        const isAutomationDisabled =
          autoState?.enabled === false ||
          hasAssignedAgent ||
          isHumanStatus;

        if (isAutomationDisabled) {
          if (autoState?.enabled !== false && (hasAssignedAgent || isHumanStatus)) {
            await this.deps.caseRepo.setAutomationEnabled(targetCase.id, false, {
              reason: "HUMAN_ASSIGNED_ACTIVE",
            });
          }
          log.info(
            {
              caseId: targetCase.id,
              status: targetCase.status,
              assignedAgentId: targetCase.assignedAgentId,
              automationEnabled: false,
            },
            "conversación en manos de una persona: silenciando bot",
          );
          return;
        }
      }

      if (humanIntervenedRecently) {
        log.info(
          { messageId: lastPrior?.id, agentId: lastPrior?.agentId, caseId: targetCase?.id },
          "el último mensaje lo envió un agente humano en caso activo: silenciando bot",
        );
        return;
      }

      const activeAggregate = await this.deps.caseRepo.findActiveByConversation(conversationId);

      const { text, receiptEntities, primaryMessageId } = await this.prepareText(messages, log);

      const hasDocumentAttachment = messages.some(
        (m) =>
          m.type === "document" ||
          m.mimeType?.includes("pdf"),
      );

      const prevCases = await this.deps.caseRepo.listByConversation(conversationId);
      let prevHasDebt = false;
      let inheritedContext: Record<string, unknown> = {};
      for (const pc of prevCases) {
        if (pc.context && typeof pc.context === "object") {
          const raw = (pc.context as Record<string, unknown>).data ?? pc.context;
          if (typeof raw === "object" && raw !== null) {
            const rawObj = raw as Record<string, unknown>;
            const bal = rawObj.balance as { hasDebt?: boolean; amount?: number; debt?: number; status?: string } | undefined;
            const hasDebt = Boolean(bal?.hasDebt || (bal?.amount ?? 0) > 0 || (bal?.debt ?? 0) > 0 || bal?.status === "DEBT");
            if (hasDebt) {
              prevHasDebt = true;
            }
            inheritedContext = {
              ...inheritedContext,
              ...rawObj,
              balance: hasDebt
                ? {
                    amount: bal?.amount ?? bal?.debt ?? undefined,
                    debt: bal?.amount ?? bal?.debt ?? undefined,
                    hasDebt: true,
                    status: "DEBT",
                    currency: "USD",
                  }
                : inheritedContext.balance ?? bal,
            };
          }
        }
      }



      const waitingStep = activeAggregate
        ? this.deps.engine.getDefinition(activeAggregate.case.workflowType)?.waitingSteps?.[
            activeAggregate.workflowInstance.currentState
          ]
        : undefined;

      const completedCases = prevCases
        .filter((c) => TERMINAL_CASE_STATUSES.includes(c.status))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      const lastCompletedCase = completedCases[0] ?? null;

      const closedMinutesAgo = lastCompletedCase
        ? Math.max(0, Math.round((Date.now() - lastCompletedCase.updatedAt.getTime()) / (60 * 1000)))
        : null;

      const previousCompletedCase =
        !activeAggregate && lastCompletedCase && closedMinutesAgo !== null && closedMinutesAgo <= 48 * 60
          ? {
              workflowType: lastCompletedCase.workflowType,
              closeReason: (lastCompletedCase.context as Record<string, unknown>)?.closeReason as string | undefined,
              resolutionNote: (lastCompletedCase.context as Record<string, unknown>)?.resolutionNote as string | null | undefined,
              closedMinutesAgo,
              summary:
                lastCompletedCase.workflowType === "SUPPORT_INTERNET"
                  ? `Soporte técnico previo resuelto hace ${closedMinutesAgo} min.`
                  : lastCompletedCase.workflowType === "BILLING_BALANCE"
                    ? `Consulta/pago de facturación previo atendido hace ${closedMinutesAgo} min.`
                    : `Caso previo ${lastCompletedCase.workflowType} cerrado hace ${closedMinutesAgo} min.`,
            }
          : null;

      const rawHistory = await this.deps.messageRepo.listByConversation(conversationId, { limit: 20 });
      // listByConversation devuelve mensajes en orden cronológico ASCENDENTE (creados antes -> creados después)
      const chronologicalHistory = [...rawHistory].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const priorChronological = chronologicalHistory.filter(
        (m) => !messages.some((bm) => bm.id === m.id),
      );

      // Si no hay caso activo, ya se envió un acuse/despedida previa tras el cierre y el cliente
      // reacciona con otro emoji o sticker sin contenido verbal, guardar silencio absoluto sin llamar a NLU.
      if (
        !activeAggregate &&
        hasAlreadySentPostCloseAck(priorChronological, lastCompletedCase) &&
        isNonVerbalPostCloseMessage(text, messages)
      ) {
        log.info(
          { conversationId, text: text.slice(0, 60) },
          "Reacción o sticker no verbal recibido tras acuse post-cierre; guardando silencio para evitar bucle",
        );
        return;
      }

      const recentMessages = priorChronological
        .filter((m) => m.body?.trim().length > 0)
        .slice(-10)
        .map((m) => ({
          author: m.author,
          body: m.body,
        }));

      let interpretation = await this.deps.interpretationProvider.interpretMessage({
        correlationId,
        conversationId,
        messageId: primaryMessageId,
        text,
        activeCase: activeAggregate
          ? {
              workflowType: activeAggregate.case.workflowType,
              pendingQuestion:
                waitingStep?.pendingQuestion ??
                (activeAggregate.case.context.workflowType === "SUPPORT_INTERNET"
                  ? activeAggregate.case.context.data.diagnostic?.lastQuestion
                  : undefined),
              requireAll: waitingStep?.requireAll,
              requireAny: waitingStep?.requireAny,
            }
          : null,
        recentMessages,
        previousCompletedCase,
      });

      // Un comprobante visual (aunque falte monto, referencia o fecha) ya es un caso de pago.
      // No hace falta que el cliente escriba "pago realizado": la imagen basta para derivar a cartera.
      // Si además reporta que no tiene internet, el soporte sigue teniendo prioridad.
      const customerText = text.replace(/\[[^\]]*Adjunto[^\]]*\]/gi, "").trim();
      const reportsOutage =
        /no tengo internet|sin internet|sin servicio|no hay internet|luz roja|m[aá]s lento|no me funciona/i.test(
          customerText,
        ) ||
        ((interpretation.intent === "support.internet" ||
          interpretation.intent === "support.slow_internet") &&
          customerText.length > 0);
      const describedAsReceipt =
        receiptEntities.isReceipt !== false &&
        /\[Adjunto[^\]]*\]/i.test(text) &&
        /comprobante|transferencia bancaria|transferencia exitosa|dep[oó]sito bancario/i.test(text);
      const visualReceipt =
        receiptEntities.isReceipt === true ||
        hasCompleteReceipt(receiptEntities) ||
        describedAsReceipt;

      if (visualReceipt && !reportsOutage) {
        interpretation = {
          type: "NEW_INTENT",
          intent: "billing.record_payment",
          entities: { ...interpretation.entities, ...receiptEntities, isReceipt: true },
          confidence: Math.max(interpretation.confidence, 0.95),
        };
      } else if (Object.keys(receiptEntities).length > 0) {
        interpretation = {
          ...interpretation,
          entities: { ...interpretation.entities, ...receiptEntities },
        };
      }

      // La IA analiza y decide el propósito real del mensaje (cierre, satisfacción o cortesía)
      // sin depender de listas de emojis ni expresiones regulares quemadas en código
      const isClosingOrThankYou = Boolean(
        interpretation.entities?.isClosing ||
        interpretation.entities?.isThankYou ||
        interpretation.entities?.isCourtesy ||
        interpretation.entities?.serviceConfirmed ||
        interpretation.type === "CANCEL",
      );

      if (isClosingOrThankYou && interpretation.intent === "billing.balance") {
        interpretation = {
          ...interpretation,
          type: "CANCEL",
          intent: "general.inquiry",
          entities: { ...interpretation.entities, isClosing: true, isThankYou: true, isCourtesy: true },
        };
      }

      // Si no hay un caso activo y el cliente expresa agradecimiento, cortesía o cierre post-atención previa:
      // 1) Si ya se envió un acuse/despedida previa tras el cierre, guardar silencio absoluto para evitar bucles.
      // 2) Caso contrario, componer una despedida 100% natural con composeReply (sin plantilla mecánica).
      if (!activeAggregate && isClosingOrThankYou) {
        if (hasAlreadySentPostCloseAck(priorChronological, lastCompletedCase)) {
          log.info(
            { conversationId, customerText: text.slice(0, 60) },
            "Agradecimiento/cortesía post-cierre ya respondido anteriormente; guardando silencio para evitar bucle",
          );
          return;
        }
        log.info(
          { interpretation, lastWorkflowType: lastCompletedCase?.workflowType },
          "Cierre / agradecimiento / cortesía post-cierre interpretado: redactando despedida natural única",
        );

        const lastAssistantOrAgentMessage = [...priorChronological]
          .reverse()
          .find((m) => m.direction === "outbound" && (m.author === "ai" || m.author === "agent"))
          ?.body?.slice(0, 280);

        const thankYouReply = await this.deps.composeReply.execute({
          caseId: lastCompletedCase?.id ?? "none",
          workflowType: lastCompletedCase?.workflowType ?? "GENERAL_INQUIRY",
          stepOutcome: {
            action: "CLOSING_ACKNOWLEDGMENT",
            status: "COMPLETED",
            result: {
              priorWorkflowType: lastCompletedCase?.workflowType ?? null,
              closeReason: previousCompletedCase?.closeReason ?? null,
              resolutionNote: previousCompletedCase?.resolutionNote ?? null,
              serviceConfirmed: Boolean(interpretation.entities?.serviceConfirmed),
              customerSentSticker: messages.some((m) => m.type.toLowerCase() === "sticker"),
              lastAssistantOrAgentMessage: lastAssistantOrAgentMessage ?? null,
            },
          },
          customerText: text,
        });

        await this.deliverFixedReply({
          conversationId,
          correlationId,
          body: thankYouReply,
          log,
        });
        return;
      }

      // Si ya hay historial previo en la conversación o un caso previo resuelto, propagar hasPriorHistory en entities
      if (previousCompletedCase || recentMessages.length > 0) {
        interpretation = {
          ...interpretation,
          entities: {
            ...interpretation.entities,
            hasPriorHistory: true,
          },
        };
      }

      // Auto-extracción de cédula SOLO cuando el intent activo o entrante es de soporte/facturación
      // (nunca inyectar nationalId en flujos de ventas, consultas generales, etc.)
      const identityRelatedIntents = ["support.internet", "support.slow_internet", "support.home_relocation", "billing.balance", "billing.record_payment"];
      const identityRelatedWorkflows = ["SUPPORT_INTERNET", "BILLING_BALANCE", "HOME_RELOCATION"];
      const isIdentityContext =
        identityRelatedIntents.includes(interpretation.intent) ||
        (activeAggregate && identityRelatedWorkflows.includes(activeAggregate.case.workflowType));

      if (isIdentityContext && !interpretation.entities?.nationalId) {
        // 1. Reutilizar desde identidad conocida del cliente
        if (this.deps.identity) {
          const stored = await this.deps.identity.tryGetCustomerIdentity(conversationId);
          if (stored?.nationalId) {
            interpretation.entities = {
              ...interpretation.entities,
              nationalId: normalizeNationalId(stored.nationalId),
            };
            log.info({ nationalId: stored.nationalId }, "cédula reutilizada automáticamente desde la identidad del cliente");
          }
        }
        // 2. Reutilizar desde casos resueltos o completados anteriormente en la misma conversación
        if (!interpretation.entities?.nationalId) {
          for (const pc of prevCases) {
            if (!TERMINAL_CASE_STATUSES.includes(pc.status)) continue;
            const raw = (pc.context as Record<string, unknown>)?.data ?? pc.context;
            const clientObj = (raw as Record<string, unknown>)?.client as { nationalId?: string } | undefined;
            if (clientObj?.nationalId) {
              const normalized = normalizeNationalId(clientObj.nationalId);
              interpretation.entities = {
                ...interpretation.entities,
                nationalId: normalized,
              };
              log.info({ nationalId: normalized, caseId: pc.id }, "cédula reutilizada automáticamente desde caso previo");
              break;
            }
          }
        }
        // 3. Fallback: extraer desde historial de mensajes
        if (!interpretation.entities?.nationalId) {
          const history = await this.deps.messageRepo.listByConversation(conversationId, { limit: 15 });
          const customerMessages = history.filter((m) => m.author === "customer");
          for (const msg of customerMessages) {
            const body = msg.body.trim();
            const match = body.match(/\b\d{9,13}\b/);
            if (match) {
              const normalized = normalizeNationalId(match[0]);
              interpretation.entities = {
                ...interpretation.entities,
                nationalId: normalized,
              };
              log.info({ nationalId: normalized, raw: match[0] }, "cédula extraída automáticamente del historial de la conversación");
              break;
            }
          }
        }
      }
      if (interpretation.entities?.nationalId) {
        interpretation.entities.nationalId = normalizeNationalId(interpretation.entities.nationalId);
      }

      // Guardrail anti-hostilidad y lenguaje inapropiado
      const guardrail = checkCustomerGuardrails(text);
      if (guardrail.isHostile) {
        log.warn(
          { reason: guardrail.reason, textPreview: text.slice(0, 80) },
          "Guardrail: hostilidad detectada en mensaje del cliente; forzando REQUEST_HUMAN",
        );
        interpretation = {
          type: "REQUEST_HUMAN",
          intent: interpretation.intent || "general.inquiry",
          entities: { ...interpretation.entities, isHostile: true, guardrailReason: guardrail.reason },
          confidence: 1.0,
        };
      }

      log.info(
        {
          textLength: text.length,
          interpretationType: interpretation.type,
          intent: interpretation.intent,
          confidence: interpretation.confidence,
          entities: interpretation.entities,
          activeWorkflowType: activeAggregate?.case.workflowType ?? null,
          requireAll: waitingStep?.requireAll ?? null,
        },
        "unidad de trabajo interpretada",
      );

      const decision = await this.deps.arbitrationService.decide({ conversationId, interpretation });
      log.info({ decision: decision.action }, "arbitraje de caso decidido");

      if (decision.action === "CLARIFY") {
        // Circuit Breaker anti-aturdimiento / anti-bucle:
        // Si el último mensaje del bot hacia el cliente ya fue una aclaración (CLARIFY),
        // no insistir por segunda vez consecutiva: escalar a triage humano.
        const lastOutbound = [...chronologicalHistory]
          .reverse()
          .find(
            (m) => m.direction === "outbound" && (m.author === "ai" || m.author === "system"),
          );
        const isConsecutiveClarify =
          lastOutbound !== undefined &&
          (lastOutbound.caption?.includes('"action":"CLARIFY"') ||
            lastOutbound.body.includes("¿En qué te puedo ayudar") ||
            lastOutbound.body.includes("¿Tienes algún inconveniente"));

        if (isConsecutiveClarify) {
          log.warn(
            { conversationId, lastOutboundBody: lastOutbound?.body?.slice(0, 60) },
            "Circuit breaker activado: múltiples intentos de aclaración consecutivos; escalando a humano",
          );
          if (this.deps.escalationService) {
            const { customerMessage } = await this.deps.escalationService.sendToTriage({
              conversationId,
              reason: "MAX_CLARIFY_ATTEMPTS_EXCEEDED",
              correlationId,
            });
            await this.deliverFixedReply({
              conversationId,
              correlationId,
              body: customerMessage || "Veo que no logré comprender tu solicitud. Te voy a transferir con un asesor de nuestro equipo para que te ayude directamente.",
              log,
            });
            return;
          }

          await this.deliverFixedReply({
            conversationId,
            correlationId,
            body: "Veo que no logré comprender tu solicitud. Te voy a transferir con un asesor de nuestro equipo para que te ayude directamente.",
            log,
          });
          return;
        }

        await this.sendCustomerReply({
          conversationId,
          correlationId,
          caseId: activeAggregate?.case.id ?? "none",
          workflowType: activeAggregate?.case.workflowType ?? "UNCLASSIFIED",
          decision: "CLARIFY",
          customerText: text,
          log,
        });
        return;
      }

      if (decision.action === "REQUEST_HUMAN") {
        const escalationReason = decision.reason ?? "REQUEST_HUMAN";
        if (decision.caseId && this.deps.escalationService) {
          const { customerMessage } = await this.deps.escalationService.escalateExistingCase({
            caseId: decision.caseId,
            reason: escalationReason,
            correlationId,
          });
          await this.deliverFixedReply({
            conversationId,
            correlationId,
            body: customerMessage,
            log,
          });
          return;
        }
        if (decision.caseId) {
          await this.escalateToHuman(decision.caseId, log);
        } else if (this.deps.escalationService) {
          const { customerMessage } = await this.deps.escalationService.sendToTriage({
            conversationId,
            reason: escalationReason,
            correlationId,
            departmentId: decision.departmentId ?? null,
          });
          await this.deliverFixedReply({
            conversationId,
            correlationId,
            body: customerMessage,
            log,
          });
          return;
        }
        await this.sendCustomerReply({
          conversationId,
          correlationId,
          caseId: decision.caseId ?? "none",
          workflowType: activeAggregate?.case.workflowType ?? "UNCLASSIFIED",
          decision: "REQUEST_HUMAN",
          customerText: text,
          log,
        });
        return;
      }

      if (decision.action === "CONTINUE_ACTIVE") {
        const advanced = await this.deps.advanceCase.execute({
          caseId: decision.caseId,
          correlationId,
          text,
          entities: seedPurposeEntities(interpretation.intent, interpretation.entities),
        });
        await this.sendCustomerReply({
          conversationId,
          correlationId,
          caseId: advanced.case.id,
          workflowType: advanced.case.workflowType,
          outcome: advanced.outcome,
          context: advanced.case.context,
          customerText: text,
          log,
        });
        return;
      }

      // ACTIVATE
      if (decision.pauseCaseId) {
        await this.pauseCase(decision.pauseCaseId, log);
      }

      // Si el workflow no esta registrado (UNSUPPORTED / Etapa 8 pendiente):
      // pool de triage sin departamento (02_STATE_MACHINE.md §10).
      if (!decision.resumeCaseId && !this.deps.engine.getDefinition(decision.workflowType)) {
        log.warn({ workflowType: decision.workflowType }, "workflow_type sin definicion; triage");
        if (this.deps.escalationService) {
          const { customerMessage } = await this.deps.escalationService.sendToTriage({
            conversationId,
            reason: `UNSUPPORTED:${decision.workflowType}`,
            correlationId,
          });
          await this.deliverFixedReply({
            conversationId,
            correlationId,
            body: customerMessage,
            log,
          });
          return;
        }
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
        decision.resumeCaseId ??
        (await this.createCase(conversationId, decision.workflowType, interpretation.intent, log)).id;
      if (decision.resumeCaseId) {
        log.info({ caseId: targetCaseId }, "caso pausado reanudado sin reiniciar el workflow");
        await this.deps.caseRepo.appendEvent(targetCaseId, "CASE_RESUMED", {});
      }

      await this.deps.conversationRepo.setActiveCaseId(conversationId, targetCaseId);

      this.deps.broadcaster?.publish({
        type: "AUTOMATION_ENABLED",
        caseId: targetCaseId,
        conversationId,
      });

      // Si la intención interpretada por la IA fue registrar un comprobante o reporte de pago (billing.record_payment):
      // - Si ya cuenta con todos los datos necesarios (cédula, monto y referencia), el workflow avanza y registra el pago automáticamente.
      // - Si no cuenta con los datos completos (caso habitual al mandar foto o aviso de pago), se deriva de inmediato a Cartera, se acusa recibo y se silencia el bot.
      if (interpretation.intent === "billing.record_payment") {
        const canAutoRecord = Boolean(
          interpretation.entities?.nationalId &&
          interpretation.entities?.amount !== undefined &&
          interpretation.entities?.reference
        );

        if (!canAutoRecord) {
          const billingDeptId = await this.deps.departmentResolver.resolveDepartmentId("BILLING_BALANCE", interpretation.intent);
          const billingDeptSlug = billingDeptId ? this.deps.departmentResolver.getDepartmentSlug(billingDeptId) : null;
          log.info(
            { departmentId: billingDeptId, departmentSlug: billingDeptSlug },
            `Comprobante/pago reportado (incompleto para auto-registro): derivando a departamento de cartera/pagos (ID: ${billingDeptId ?? "desconocido"})`,
          );

        if (activeAggregate && activeAggregate.case.workflowType === "SUPPORT_INTERNET") {
          await this.deps.caseRepo.applyTransition({
            caseId: activeAggregate.case.id,
            expectedCaseVersion: activeAggregate.case.version,
            expectedWorkflowVersion: activeAggregate.workflowInstance.version,
            status: "COMPLETED",
            context: activeAggregate.case.context,
            currentState: "CLOSED_PENDING_PAYMENT",
            expiresAt: null,
          });
        }

        const fresh = await this.deps.caseRepo.findById(targetCaseId);
        if (fresh) {
          const rawBalance = inheritedContext.balance as Record<string, unknown> | undefined;
          const inheritedClient = (inheritedContext as { client?: { nationalId: string; fullName: string } }).client;
          const mergedContext: BillingBalanceContext = {
            purpose: "record_payment",
            client: inheritedClient,
            balance: {
              hasDebt: true,
              amount:
                typeof rawBalance?.amount === "number"
                  ? rawBalance.amount
                  : typeof rawBalance?.debt === "number"
                    ? rawBalance.debt
                    : undefined,
            },
            payment: {
              amount: typeof interpretation.entities?.amount === "number" ? interpretation.entities.amount : undefined,
              reference: typeof interpretation.entities?.reference === "string" ? interpretation.entities.reference : undefined,
              date: typeof interpretation.entities?.date === "string" ? interpretation.entities.date : undefined,
              status: "PENDING",
            },
          };

          await this.deps.caseRepo.applyTransition({
            caseId: targetCaseId,
            expectedCaseVersion: fresh.case.version,
            expectedWorkflowVersion: fresh.workflowInstance.version,
            status: visualReceipt ? fresh.case.status : "WAITING_USER",
            context: {
              workflowType: "BILLING_BALANCE",
              data: mergedContext,
            },
            currentState: visualReceipt ? fresh.workflowInstance.currentState : "WAITING_USER_RECEIPT",
            expiresAt: null,
            departmentId: billingDeptId,
          });
        }

        if (visualReceipt) {
          if (this.deps.escalationService) {
            await this.deps.escalationService.escalateExistingCase({
              caseId: targetCaseId,
              reason: "Comprobante de pago adjunto (documento/imagen)",
              correlationId,
            });
          }

          await this.deps.caseRepo.setAutomationEnabled(targetCaseId, false, {
            reason: "PAYMENT_RECEIPT_ESCALATED",
          });
          await this.deps.conversationRepo.setActiveCaseId(conversationId, targetCaseId);

          const amountFromEntities = typeof interpretation.entities?.amount === "number" ? interpretation.entities.amount : undefined;
          const amountFromTextMatch = text.match(/\$\s*(\d+[\.,]\d{2})|\b(\d+[\.,]\d{2})\b/);
          const textAmountRaw = amountFromTextMatch ? (amountFromTextMatch[1] ?? amountFromTextMatch[2])?.replace(',', '.') : undefined;
          const textAmount = textAmountRaw && Number.isFinite(Number(textAmountRaw)) ? Number(textAmountRaw) : undefined;
          const rawAmount = amountFromEntities ?? textAmount ?? (inheritedContext.balance as { amount?: number; debt?: number } | undefined)?.amount;
          const amountFormatted =
            typeof rawAmount === "number" && Number.isFinite(rawAmount)
              ? '$' + rawAmount.toFixed(2).replace('.', ',')
              : null;

          const amountStr = amountFormatted ? 'de ' + amountFormatted + ' ' : '';
          const replyMessage =
            ('¡Recibido, gracias! 🙌 Estamos verificando tu comprobante de pago ' + amountStr + 'y te confirmamos por aquí mismo en cuanto quede listo. ¡Gracias por tu confianza!').replace("  ", " ");

          await this.deliverFixedReply({
            conversationId,
            correlationId,
            body: replyMessage,
            log,
          });
          return;
        } else {
          // NO hay comprobante visual adjunto: no mentir diciendo que se recibió el comprobante
          await this.deps.caseRepo.appendEvent(targetCaseId, "WAITING_USER", {
            nextState: "WAITING_USER_RECEIPT",
            missingFields: ["amount", "reference"],
            waitingAttempts: 0,
          });
          const replyMessage =
            "Para poder verificar y registrar tu pago en el sistema, por favor envíanos una foto o captura del comprobante de transferencia o depósito bancario.";
          await this.deliverFixedReply({
            conversationId,
            correlationId,
            body: replyMessage,
            log,
          });
          return;
        }
        }
      }

      // Si el caso está configurado en modo human_direct, se escala de inmediato sin avance de IA
      if (!decision.resumeCaseId && this.deps.routingService) {
        const routing = await this.deps.routingService.resolveByIntent(interpretation.intent);
        if (routing?.handlingMode === "human_direct" && this.deps.escalationService) {
          log.info(
            { caseId: targetCaseId, intent: interpretation.intent, routingId: routing.id },
            "caso configurado como human_direct; escalando directamente a agentes humanos del departamento",
          );
          const { customerMessage } = await this.deps.escalationService.escalateExistingCase({
            caseId: targetCaseId,
            reason: `Atención personalizada requerida: ${routing.label}`,
            correlationId,
          });
          await this.deliverFixedReply({
            conversationId,
            correlationId,
            body: customerMessage,
            log,
          });
          return;
        }
      }

      const seededEntities = seedPurposeEntities(interpretation.intent, interpretation.entities);
      const advanced = await this.deps.advanceCase.execute({
        caseId: targetCaseId,
        correlationId,
        text,
        entities: seededEntities,
      });
      await this.sendCustomerReply({
        conversationId,
        correlationId,
        caseId: advanced.case.id,
        workflowType: advanced.case.workflowType,
        outcome: advanced.outcome,
        context: advanced.case.context,
        customerText: text,
        log,
      });
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, "Error fatal procesando lote de mensajes");
      try {
        const activeAggregate = await this.deps.caseRepo.findActiveByConversation(conversationId);
        let fallbackMessage = "Disculpa, tuvimos un inconveniente técnico al procesar tu mensaje. Un especialista se comunicará con vos en breve para ayudarte.";

        if (activeAggregate) {
          if (this.deps.escalationService) {
            const { customerMessage } = await this.deps.escalationService.escalateExistingCase({
              caseId: activeAggregate.case.id,
              reason: "EXTERNAL_SERVICE_ERROR",
              correlationId,
            });
            fallbackMessage = customerMessage;
          } else {
            await this.escalateToHuman(activeAggregate.case.id, log);
          }
        } else {
          if (this.deps.escalationService) {
            const { customerMessage } = await this.deps.escalationService.sendToTriage({
              conversationId,
              reason: "EXTERNAL_SERVICE_ERROR",
              correlationId,
            });
            fallbackMessage = customerMessage;
          }
        }

        await this.deliverFixedReply({
          conversationId,
          correlationId,
          body: fallbackMessage,
          log,
        });
      } catch (fallbackError) {
        log.error(
          { err: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) },
          "Error crítico en el fallback de recuperación",
        );
      }
    }
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

      if (type === "sticker" || message.body?.trim().toLowerCase() === "[sticker]") {
        parts.push("[Sticker enviado por el cliente]");
        if (message.caption?.trim()) parts.push(message.caption.trim());
        continue;
      }

      if (type === "image") {
        try {
          const mediaUrl = message.mediaId ?? "";
          const receipt = await this.deps.extractReceiptData.execute(
            mediaUrl,
            message.mimeType ?? "image/jpeg",
          );
          if (receipt.isReceipt === true || receipt.amount !== undefined || receipt.reference !== undefined) {
            Object.assign(receiptEntities, receipt);
          } else if (receipt.isReceipt === false) {
            receiptEntities.isReceipt = false;
          }
          if (receipt.description) {
            parts.push(`[Adjunto imagen: ${receipt.description}]`);
          } else if (receipt.isReceipt === true) {
            parts.push(`[Adjunto: foto de comprobante de pago/transferencia bancaria]`);
          } else if (receipt.isReceipt === false) {
            parts.push(`[Adjunto: imagen de equipo/dispositivo de red]`);
          } else {
            parts.push(`[Adjunto: imagen/foto enviada por el cliente]`);
          }
          if (message.caption) parts.push(message.caption);
          else if (message.body && message.body !== "[image]") parts.push(message.body);
        } catch (error) {
          log.warn(
            { messageId: message.id, err: error instanceof Error ? error.message : String(error) },
            "fallo extractReceiptData; se usa caption/body si hay",
          );
          parts.push(`[Adjunto: imagen/foto enviada por el cliente]`);
          if (message.caption) parts.push(message.caption);
          else if (message.body && message.body !== "[image]") parts.push(message.body);
        }
        continue;
      }

      if (type === "video") {
        try {
          const mediaUrl = message.mediaId ?? "";
          const analysis = await this.deps.extractReceiptData.execute(
            mediaUrl,
            message.mimeType ?? "video/mp4",
          );
          if (analysis.isReceipt === true || analysis.amount !== undefined || analysis.reference !== undefined) {
            Object.assign(receiptEntities, analysis);
          } else if (analysis.isReceipt === false) {
            receiptEntities.isReceipt = false;
          }
          if (analysis.description) {
            parts.push(`[Adjunto video: ${analysis.description}]`);
          } else if (analysis.isReceipt === true) {
            parts.push(`[Adjunto: video de comprobante de pago/transferencia bancaria]`);
          } else if (analysis.isReceipt === false) {
            parts.push(`[Adjunto: video de equipo o pantalla (no es comprobante)]`);
          } else {
            parts.push(`[Adjunto: video enviado por el cliente]`);
          }
          if (message.caption) parts.push(message.caption);
          else if (message.body && message.body !== "[video]") parts.push(message.body);
        } catch (error) {
          log.warn(
            { messageId: message.id, err: error instanceof Error ? error.message : String(error) },
            "fallo analisis visual de video; se usa caption/body si hay",
          );
          parts.push(`[Adjunto: video enviado por el cliente]`);
          if (message.caption) parts.push(message.caption);
          else if (message.body && message.body !== "[video]") parts.push(message.body);
        }
        continue;
      }

      if (type === "document") {
        const mime = message.mimeType?.toLowerCase() ?? "";
        const isPdfOrImageDoc = mime.includes("pdf") || mime.includes("image");
        if (isPdfOrImageDoc && message.mediaId) {
          try {
            const analysis = await this.deps.extractReceiptData.execute(
              message.mediaId,
              message.mimeType ?? "application/pdf",
            );
            if (analysis.isReceipt === true || analysis.amount !== undefined || analysis.reference !== undefined) {
              Object.assign(receiptEntities, analysis);
            } else if (analysis.isReceipt === false) {
              receiptEntities.isReceipt = false;
            }
            if (analysis.description) {
              parts.push(`[Adjunto documento: ${analysis.description}]`);
            } else if (analysis.isReceipt === true) {
              parts.push(`[Adjunto: documento de comprobante de pago/transferencia]`);
            } else if (message.filename) {
              parts.push(`[Adjunto documento: ${message.filename}]`);
            } else {
              parts.push(`[Adjunto: documento digital]`);
            }
            if (message.caption) parts.push(message.caption);
            continue;
          } catch (error) {
            log.warn(
              { messageId: message.id, err: error instanceof Error ? error.message : String(error) },
              "fallo analisis de documento; se usa filename/caption",
            );
          }
        }

        if (message.caption) parts.push(message.caption);
        else if (message.filename) parts.push(`[Adjunto documento: ${message.filename}]`);
        else parts.push(`[Adjunto: documento digital]`);
        continue;
      }

      if (type === "location" || (message.filename && /([-+]?\d{1,2}\.\d+)\s*,\s*([-+]?\d{1,3}\.\d+)/.test(message.filename))) {
        const coords = message.filename || (message.body?.match(/([-+]?\d{1,2}\.\d+)\s*,\s*([-+]?\d{1,3}\.\d+)/)?.[0]);
        if (coords) {
          parts.push(`Ubicación GPS: ${coords}`);
        }
        if (message.body && !message.body.startsWith("Ubicación GPS:") && message.body !== "📍 Location") {
          parts.push(message.body);
        }
        continue;
      }

      if (message.body.trim()) parts.push(message.body.trim());
    }

    return { text: parts.join("\n"), receiptEntities, primaryMessageId };
  }

  private async deliverFixedReply(input: {
    conversationId: string;
    correlationId: string;
    body: string;
    log: Logger;
  }): Promise<void> {
    const conversation = await this.deps.conversationRepo.findById(input.conversationId);
    if (!conversation) {
      input.log.warn("conversacion no encontrada al enviar reply fijo");
      return;
    }
    let externalId: string | null = null;
    let sendFailed = false;
    let errorMessage: string | null = null;
    try {
      const sent = await this.deps.whatsappSender.sendText(conversation.waPhone, input.body);
      externalId = sent.externalId;
    } catch (error) {
      sendFailed = true;
      errorMessage = error instanceof Error ? error.message : String(error);
      input.log.error(
        { err: errorMessage },
        "fallo al enviar reply fijo por WhatsApp",
      );
    }
    const outbound = await this.deps.messageRepo.insertOutbound({
      conversationId: input.conversationId,
      author: "ai",
      body: input.body,
      externalId,
      status: sendFailed ? "failed" : "sent",
      errorMessage: sendFailed ? errorMessage : undefined,
    });
    if (sendFailed) {
      this.deps.broadcaster?.publish({
        type: "MESSAGE_STATUS_UPDATED",
        conversationId: input.conversationId,
        messageId: outbound.id,
        status: "failed",
        errorMessage,
      });
    } else {
      this.deps.broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: input.conversationId,
        messageId: outbound.id,
        author: "ai",
      });
    }
  }

  private async sendCustomerReply(input: {
    conversationId: string;
    correlationId: string;
    caseId: string;
    workflowType: string;
    outcome?: Parameters<typeof resolveReplyTemplate>[0]["outcome"];
    context?: CaseContext;
    decision?: "CLARIFY" | "REQUEST_HUMAN";
    customerText?: string;
    log: Logger;
  }): Promise<void> {
    const definition = this.deps.engine.getDefinition(input.workflowType);
    const resolved = resolveReplyTemplate({
      definition,
      outcome: input.outcome,
      decision: input.decision,
      context: input.context,
      customerText: input.customerText,
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
      missingFields: resolved.missingFields,
      customerText: input.customerText,
    });

    const conversation = await this.deps.conversationRepo.findById(input.conversationId);
    if (!conversation) {
      input.log.warn("conversacion no encontrada al enviar reply de IA");
      return;
    }

    let externalId: string | null = null;
    let sendFailed = false;
    let errorMessage: string | null = null;
    let messageType = "text";
    let messageCaption: string | null =
      input.decision === "CLARIFY" ? JSON.stringify({ action: "CLARIFY" }) : null;
    const contextData = input.context && "data" in input.context ? (input.context.data as Record<string, unknown>) : {};
    const pendingContracts = Array.isArray(contextData.pendingContracts)
      ? (contextData.pendingContracts as Array<{ id: string; label?: string; address?: string; sector?: string; contractCode?: string }>)
      : [];

    try {
      if (
        input.outcome?.type === "WAITING_USER" &&
        input.outcome.nextState === "WAITING_USER_DISAMBIGUATE" &&
        pendingContracts.length > 1
      ) {
        try {
          if (this.deps.whatsappSender.sendInteractiveList && pendingContracts.length > 2) {
            const rows = pendingContracts.slice(0, 10).map((c, idx) => {
              const num = idx + 1;
              const sectorPart = c.sector ? ` (${c.sector})` : "";
              const cleanLabel = (c.label || c.address || `Contrato #${c.contractCode || c.id}`).trim();
              const title = `${num}. ${cleanLabel}${sectorPart}`.slice(0, 24);
              const desc = (c.address || (c.sector ? `Sector ${c.sector}` : `ID: ${c.id}`)).trim().slice(0, 72);
              return {
                id: `option_${num}`,
                title,
                description: desc !== title && desc.length > 0 ? desc : undefined,
              };
            });
            const sent = await this.deps.whatsappSender.sendInteractiveList(
              conversation.waPhone,
              body,
              "Ver opciones",
              [{ title: "Servicios disponibles", rows }],
            );
            externalId = sent.externalId;
            messageType = "interactive";
            messageCaption = JSON.stringify({
              type: "list",
              buttonText: "Ver opciones",
              sections: [{ title: "Servicios disponibles", rows }],
            });
          } else if (this.deps.whatsappSender.sendInteractiveButtons && pendingContracts.length === 2) {
            const seenTitles = new Set<string>();
            const buttons = pendingContracts.map((c, idx) => {
              const num = idx + 1;
              const sector = c.sector ? c.sector.trim().toLowerCase() : "";
              const addrMatch = c.address?.match(/(?:OE|N|S|E)?\d+[-\d]*/i)?.[0];
              const contractId = c.contractCode || c.id;

              let title = "";
              if (addrMatch && sector) {
                const candidate = `${num}. ${addrMatch} (${sector})`;
                if (candidate.length <= 20) title = candidate;
              }
              if (!title && addrMatch) {
                const candidate = `${num}. ${addrMatch} (#${contractId})`;
                if (candidate.length <= 20) title = candidate;
              }
              if (!title && sector) {
                const candidate = `${num}. #${contractId} (${sector})`;
                if (candidate.length <= 20) title = candidate;
              }
              if (!title) {
                const candidate = `${num}. Contrato #${contractId}`;
                title = candidate.length <= 20 ? candidate : `Opción ${num}`;
              }

              if (seenTitles.has(title)) {
                title = `${num}. #${contractId}`.slice(0, 20);
              }
              if (seenTitles.has(title)) {
                title = `Opción ${num}`.slice(0, 20);
              }
              seenTitles.add(title);
              return {
                id: `option_${num}`,
                title,
              };
            });
            const sent = await this.deps.whatsappSender.sendInteractiveButtons(
              conversation.waPhone,
              body,
              buttons,
            );
            externalId = sent.externalId;
            messageType = "interactive";
            messageCaption = JSON.stringify({
              type: "buttons",
              buttons,
            });
          } else {
            const sent = await this.deps.whatsappSender.sendText(conversation.waPhone, body);
            externalId = sent.externalId;
          }
        } catch (interactiveError) {
          input.log.warn(
            { err: interactiveError instanceof Error ? interactiveError.message : String(interactiveError) },
            "Fallo al enviar mensaje interactivo (botones/lista), ejecutando fallback inmediato a texto plano",
          );
          messageType = "text";
          messageCaption = null;
          const sent = await this.deps.whatsappSender.sendText(conversation.waPhone, body);
          externalId = sent.externalId;
        }
      } else {
        const sent = await this.deps.whatsappSender.sendText(conversation.waPhone, body);
        externalId = sent.externalId;
      }
    } catch (error) {
      sendFailed = true;
      errorMessage = error instanceof Error ? error.message : String(error);
      input.log.error(
        { err: errorMessage },
        "fallo al enviar reply de IA por WhatsApp; se persiste igual",
      );
    }

    const outbound = await this.deps.messageRepo.insertOutbound({
      conversationId: input.conversationId,
      author: "ai",
      body,
      type: messageType,
      caption: messageCaption,
      externalId,
      status: sendFailed ? "failed" : "sent",
      errorMessage: sendFailed ? errorMessage : undefined,
    });
    if (sendFailed) {
      this.deps.broadcaster?.publish({
        type: "MESSAGE_STATUS_UPDATED",
        conversationId: input.conversationId,
        messageId: outbound.id,
        status: "failed",
        errorMessage,
      });
    } else {
      this.deps.broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: input.conversationId,
        messageId: outbound.id,
        author: "ai",
      });
    }
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

  private async createCase(
    conversationId: string,
    workflowType: string,
    intent: string,
    log: Logger,
  ): Promise<Case> {
    const definition = this.deps.engine.getDefinition(workflowType);
    if (!definition) {
      throw new DomainError("UNSUPPORTED", `No hay WorkflowDefinition registrada para '${workflowType}'`);
    }

    const departmentId = await this.deps.departmentResolver.resolveDepartmentId(workflowType, intent);
    const expiresAt = new Date(Date.now() + definition.expirationHours * 60 * 60 * 1000);
    const context = seedInitialContext(workflowType, intent);

    const aggregate = await this.deps.caseRepo.create({
      conversationId,
      workflowType,
      departmentId,
      context,
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

function seedPurposeEntities(
  intent: string,
  entities: Record<string, unknown>,
): Record<string, unknown> {
  if (intent === "billing.record_payment") {
    return { ...entities, billingPurpose: "record_payment" };
  }
  if (intent === "billing.balance") {
    return { ...entities, billingPurpose: "balance" };
  }
  if (intent === "billing.payment_methods") {
    return { ...entities, billingPurpose: "payment_methods" };
  }
  if (intent === "sales.new_contract") {
    return { ...entities, salesPurpose: "sales" };
  }
  if (intent === "sales.plans") {
    return { ...entities, salesPurpose: "plans" };
  }
  if (intent === "sales.upgrade") {
    return { ...entities, wantsUpgrade: true, salesPurpose: "upgrade" };
  }
  return entities;
}

function seedInitialContext(workflowType: string, intent: string): CaseContext {
  const base = emptyContextFor(workflowType as CaseContext["workflowType"]);
  if (base.workflowType === "BILLING_BALANCE") {
    return {
      ...base,
      data: {
        ...base.data,
        purpose: intent === "billing.record_payment" ? "record_payment" : "balance",
      },
    };
  }
  if (base.workflowType === "SALES" || base.workflowType === "SALES_PACKAGES") {
    let purpose: "sales" | "plans" | "upgrade" = "sales";
    if (intent === "sales.upgrade") purpose = "upgrade";
    else if (intent === "sales.plans") purpose = "plans";
    return {
      ...base,
      data: {
        ...base.data,
        purpose,
      },
    };
  }
  return base;
}

function isClosingSystemMessage(body: string): boolean {
  const lower = body.toLowerCase();
  return body.includes("🔒") || lower.includes("caso completado") || lower.includes("caso cerrado");
}

function looksLikeClosingAckBody(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("con mucho gusto") ||
    lower.includes("excelente día") ||
    lower.includes("excelente dia") ||
    lower.includes("a las órdenes") ||
    lower.includes("a las ordenes") ||
    lower.includes("a tus órdenes") ||
    lower.includes("a tu disposición") ||
    lower.includes("a tu disposicion") ||
    lower.includes("a la orden") ||
    lower.includes("un gusto") ||
    lower.includes("para servirte") ||
    lower.includes("quedamos pendientes") ||
    lower.includes("quedó registrado correctamente")
  );
}

function isNonVerbalPostCloseMessage(text: string, messages: Message[]): boolean {
  if (messages.length > 0 && messages.every((m) => m.type.toLowerCase() === "sticker")) {
    return true;
  }
  const stripped = text
    .replace(/\[Sticker enviado por el cliente\]/gi, "")
    .replace(/\[sticker\]/gi, "")
    .trim();
  return !/[\p{L}\p{N}]/u.test(stripped);
}

function hasAlreadySentPostCloseAck(
  priorChronological: Message[],
  lastCompletedCase: { updatedAt: Date } | null,
): boolean {
  let lastCloseMarkerIdx = -1;
  for (let i = priorChronological.length - 1; i >= 0; i -= 1) {
    const msg = priorChronological[i]!;
    if (msg.author === "system" && isClosingSystemMessage(msg.body)) {
      lastCloseMarkerIdx = i;
      break;
    }
  }

  if (lastCloseMarkerIdx >= 0) {
    const afterClose = priorChronological.slice(lastCloseMarkerIdx + 1);
    if (afterClose.some((m) => m.direction === "outbound" && m.author === "ai")) {
      return true;
    }
  }

  if (lastCompletedCase) {
    const closedAtMs = lastCompletedCase.updatedAt.getTime();
    const aiAckAfterCaseClose = priorChronological.some(
      (m) =>
        m.direction === "outbound" &&
        m.author === "ai" &&
        m.createdAt.getTime() >= closedAtMs - 5000,
    );
    if (aiAckAfterCaseClose) {
      return true;
    }
  }

  const lastOutbound = [...priorChronological]
    .reverse()
    .find((m) => m.direction === "outbound" && m.author !== "system");
  if (lastOutbound && lastOutbound.author === "ai") {
    return looksLikeClosingAckBody(lastOutbound.body) || lastCompletedCase !== null;
  }
  return false;
}
