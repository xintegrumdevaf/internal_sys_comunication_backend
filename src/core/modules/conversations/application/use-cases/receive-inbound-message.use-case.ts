import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { withConversationLock } from "../../../../../shared/queue/redis";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Conversation } from "../../domain/conversation.entity";
import type { Message } from "../../domain/message.entity";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { MediaStoragePort } from "../ports/media-storage.port";
import type { InboundBufferService } from "../../../ingestion/application/services/inbound-buffer.service";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import { TERMINAL_CASE_STATUSES, type Case } from "../../../cases/domain/case.entity";
import type { CrmBridgePort } from "../../../crm-bridge/application/ports/crm-bridge.port";
import { resolveConversationCases } from "../services/resolve-conversation-cases";

export type ReceiveInboundMessageInput = {
  waPhone: string;
  externalId: string;
  body: string;
  type: string;
  mediaId?: string | null;
  mimeType?: string | null;
  caption?: string | null;
  filename?: string | null;
  replyToExternalId?: string | null;
  replyToMessageId?: string | null;
  isForwarded?: boolean;
  /** `contacts[].profile.name` del webhook de Meta — ver conversation.entity.ts. */
  waProfileName?: string | null;
  /** correlationId de la request HTTP que origino el mensaje (trazabilidad, AGENTS.md). */
  correlationId?: string;
  direction?: "inbound" | "outbound";
  author?: import("../../domain/message.entity").MessageAuthor;
  createdAt?: Date;
};

export type ReceiveInboundMessageResult = {
  conversation: Conversation;
  message: Message;
  isDuplicate: boolean;
  isEdited?: boolean;
};

export type ReceiveInboundMessageDeps = {
  conversationRepo: ConversationRepositoryPort;
  messageRepo: MessageRepositoryPort;
  redisClient: Redis;
  logger: Logger;
  /** Opcional: si no se inyecta, el mensaje se persiste pero no se agrupa (tests de Etapa 1). */
  inboundBuffer?: InboundBufferService;
  broadcaster?: RealtimeBroadcaster;
  /** Almacenamiento local permanente para descargar imágenes, audios, videos y documentos al recibir el webhook. */
  mediaStorage?: MediaStoragePort;
  caseRepo?: CaseRepositoryPort;
  crmBridge?: CrmBridgePort;
};

/**
 * Ingesta de mensaje inbound o saliente enviado desde WhatsApp movil (docs/spec/05_BUILD_PLAN.md Etapa 1).
 * Unico caso de uso que crea/reutiliza una Conversation y persiste el
 * mensaje crudo de forma idempotente, serializado por wa_phone via Redis.
 * Tras persistir, empuja el mensaje al buffer/debounce por conversacion
 * (docs/spec/02_STATE_MACHINE.md §12, Etapa 2) — nunca para un duplicado o saliente.
 */
export class ReceiveInboundMessageUseCase {
  constructor(private readonly deps: ReceiveInboundMessageDeps) {}

  async execute(input: ReceiveInboundMessageInput): Promise<ReceiveInboundMessageResult> {
    const { conversationRepo, messageRepo, redisClient, inboundBuffer, logger } = this.deps;
    const log = input.correlationId
      ? logger.child({ correlationId: input.correlationId })
      : logger;

    const isOutbound = input.direction === "outbound";

    let conversation = await withConversationLock(redisClient, input.waPhone, () =>
      conversationRepo.findOrCreateByWaPhone(input.waPhone),
    );

    // Se actualiza en cada mensaje que lo traiga (la persona puede cambiar su
    // nombre de WhatsApp); nunca se pisa un nombre ya conocido con uno vacio.
    if (!isOutbound && input.waProfileName && input.waProfileName !== conversation.waProfileName) {
      await conversationRepo.setWaProfileName(conversation.id, input.waProfileName);
      conversation = { ...conversation, waProfileName: input.waProfileName };
    }

    const { message, isDuplicate, isEdited } = await messageRepo.insertInbound({
      conversationId: conversation.id,
      externalId: input.externalId,
      body: input.body,
      type: input.type,
      mediaId: input.mediaId ?? null,
      mimeType: input.mimeType ?? null,
      caption: input.caption ?? null,
      filename: input.filename ?? null,
      replyToExternalId: input.replyToExternalId ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      isForwarded: Boolean(input.isForwarded),
      direction: input.direction,
      author: input.author,
      createdAt: input.createdAt,
    });

    log.info(
      {
        conversationId: conversation.id,
        messageId: message.id,
        externalId: input.externalId,
        waPhone: input.waPhone,
        type: input.type,
        body: input.body,
        direction: input.direction ?? "inbound",
        isDuplicate,
        isEdited: Boolean(isEdited),
      },
      isDuplicate
        ? "mensaje webhook duplicado, se descarta"
        : isEdited
        ? "mensaje editado y actualizado en DB"
        : "mensaje webhook recibido y persistido",
    );

    if (isEdited) {
      this.deps.broadcaster?.publish({
        type: "MESSAGE_UPDATED",
        conversationId: conversation.id,
        messageId: message.id,
        body: message.body,
      });
    }

    if (!isDuplicate) {
      if (input.mediaId && input.type !== "location" && this.deps.mediaStorage) {
        void this.deps.mediaStorage
          .ensureStored(input.mediaId, {
            mimeType: input.mimeType,
            filename: input.filename,
          })
          .catch((err) => {
            log.warn(
              { err, messageId: message.id, mediaId: input.mediaId },
              "fallo descarga proactiva de media al disco local; se reintentara en /api/media",
            );
          });
      }

      if (!isOutbound) {
        if (conversation.status === "pending") {
          // Si la conversación no tiene un caso activo asociado, se reabre a open.
          // Si tiene caso activo (ej. en espera de visita técnica o retoma humana),
          // delegamos la reapertura a ProcessBufferedMessages para evaluar la intención NLU
          // y no quebrar el estado de espera ante confirmaciones o agradecimientos.
          if (!conversation.activeCaseId) {
            log.info(
              { conversationId: conversation.id },
              "reabriendo conversacion en espera sin caso activo por mensaje del cliente",
            );
            await conversationRepo.setStatus(conversation.id, "open");
            conversation = { ...conversation, status: "open" };
          }
        } else if (conversation.status === "resolved" || conversation.status === "closed") {
          // Delegamos la reapertura de conversaciones resueltas/cerradas a ProcessBufferedMessages
          // para evaluar la intención real con NLU (evitando reabrir por despedidas o cortesías).
          // Si no hay buffer configurado, reabrimos directamente.
          if (!inboundBuffer) {
            log.info({ conversationId: conversation.id }, "reabriendo conversacion resuelta/cerrada sin buffer NLU");
            await conversationRepo.setStatus(conversation.id, "open");
            conversation = { ...conversation, status: "open" };
          }
        }

        await conversationRepo.incrementUnreadCount(conversation.id);
        await conversationRepo.touchLastActivity(conversation.id);
        await inboundBuffer?.push(conversation.id, message.id);

        let activeCase: Case | null = null;
        if (this.deps.caseRepo) {
          try {
            const cases = await this.deps.caseRepo.listByConversation(conversation.id);
            activeCase = resolveConversationCases(conversation, cases).activeCase;
            if (!activeCase && conversation.activeCaseId) {
              const aggregate = await this.deps.caseRepo.findById(conversation.activeCaseId);
              if (aggregate && !TERMINAL_CASE_STATUSES.includes(aggregate.case.status)) {
                activeCase = aggregate.case;
              }
            }
          } catch {
            // No bloquear la ingesta si la lectura del caso falla
          }
        }

        const isHumanActive = activeCase
          ? activeCase.status === "HUMAN_ACTIVE" || activeCase.status === "ESCALATED"
          : false;

        if (activeCase && this.deps.crmBridge?.isEnabled()) {
          let isCrmLinked =
            activeCase.workflowType === "SALES" ||
            activeCase.workflowType === "SALES_PACKAGES";
          if (!isCrmLinked && this.deps.caseRepo) {
            const auto = await this.deps.caseRepo
              .getAutomationState(activeCase.id)
              .catch(() => null);
            isCrmLinked = auto?.disabledReason === "CRM_HUMAN_HANDOFF";
          }
          if (isCrmLinked) {
            void this.deps.crmBridge
              .notifySalesEvent(
                {
                  eventId: message.externalId || `isp-in-${message.id}-${randomUUID().slice(0, 6)}`,
                  eventType: "sales.message.received",
                  occurredAt: new Date().toISOString(),
                  conversationId: conversation.id,
                  caseId: activeCase.id,
                  customerId: conversation.customerId ?? undefined,
                  waPhone: conversation.waPhone,
                  fullName: input.waProfileName || conversation.waProfileName || undefined,
                  lastMessageBody: input.body,
                },
                { correlationId: input.correlationId },
              )
              .catch((err) => {
                log.warn({ err, messageId: message.id }, "fallo notificación inbound a CRM");
              });
          }
        }

        this.deps.broadcaster?.publish({
          type: "MESSAGE_RECEIVED",
          conversationId: conversation.id,
          messageId: message.id,
          bodyPreview:
            input.body.substring(0, 100) ||
            (input.type === "document"
              ? "📄 Documento"
              : input.type === "image"
                ? "📷 Imagen"
                : input.type === "video"
                  ? "🎥 Video"
                  : input.type === "audio" || input.type === "voice"
                    ? "🎤 Audio"
                    : "Mensaje nuevo"),
          authorName: input.waProfileName || conversation.waProfileName || conversation.waPhone,
          departmentId: activeCase?.departmentId ?? null,
          assignedAgentId: activeCase?.assignedAgentId ?? null,
          isHumanActive,
        });
      } else {
        await conversationRepo.touchLastActivity(conversation.id);
        this.deps.broadcaster?.publish({
          type: "MESSAGE_SENT",
          conversationId: conversation.id,
          messageId: message.id,
          author: message.author !== "customer" ? message.author : "agent",
        });
      }
    }

    return { conversation, message, isDuplicate, isEdited: Boolean(isEdited) };
  }
}
