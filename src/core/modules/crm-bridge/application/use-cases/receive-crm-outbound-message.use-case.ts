import type Redis from "ioredis";
import { validationError } from "../../../../../shared/errors/domain-errors";
import { normalizePhoneDigits } from "../../../../../shared/http/crm-signature";
import type { Logger } from "../../../../../shared/logging/logger";
import { withConversationLock } from "../../../../../shared/queue/redis";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import { TERMINAL_CASE_STATUSES } from "../../../cases/domain/case.entity";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";
import type { WhatsAppSenderPort } from "../../../conversations/application/ports/whatsapp-sender.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export interface CrmOutboundMessagePayload {
  idempotencyKey?: string;
  externalMessageId?: string;
  toPhone?: string;
  body?: string;
  agentName?: string;
  actorName?: string;
  pauseBot?: boolean;
  payload?: {
    externalMessageId?: string;
    toPhone?: string;
    body?: string;
    actorName?: string;
    agentName?: string;
    pauseBot?: boolean;
  };
}

export interface ReceiveCrmOutboundMessageResult {
  duplicate: boolean;
  delivered: boolean;
  conversationId: string | null;
  messageId: string | null;
  externalId: string | null;
  pausedCaseId: string | null;
}

export interface ReceiveCrmOutboundMessageDeps {
  conversationRepo: ConversationRepositoryPort;
  messageRepo: MessageRepositoryPort;
  whatsappSender: WhatsAppSenderPort;
  caseRepo?: CaseRepositoryPort;
  auditRepo?: AuditRepositoryPort;
  broadcaster?: RealtimeBroadcaster;
  redisClient?: Redis;
  logger: Logger;
}

/**
 * Receives outbound WhatsApp dispatch requests from CRM_sys_backend
 * (direct Ficha 360 sends or OutboxRelayWorker retries) with idempotency.
 */
export class ReceiveCrmOutboundMessageUseCase {
  private readonly processedKeys = new Set<string>();

  constructor(private readonly deps: ReceiveCrmOutboundMessageDeps) {}

  private async claimIdempotencyKey(key: string): Promise<boolean> {
    if (!key) return true;
    if (this.processedKeys.has(key)) return false;

    const redis = this.deps.redisClient;
    if (redis && redis.status === "ready") {
      try {
        const res = await redis.set(`crm:outbound:${key}`, "1", "EX", 86400, "NX");
        if (res !== "OK") {
          this.processedKeys.add(key);
          return false;
        }
      } catch (err) {
        this.deps.logger.warn({ err, idempotencyKey: key }, "fallo lock Redis de idempotencia CRM; usando fallback en memoria");
      }
    }

    this.processedKeys.add(key);
    return true;
  }

  async execute(input: CrmOutboundMessagePayload): Promise<ReceiveCrmOutboundMessageResult> {
    const inner = input.payload ?? input;
    const rawPhone = (inner.toPhone ?? input.toPhone ?? "").trim();
    const text = (inner.body ?? input.body ?? "").trim();
    const idempotencyKey = (
      inner.externalMessageId ??
      input.externalMessageId ??
      input.idempotencyKey ??
      ""
    ).trim();
    const agentName = (inner.agentName ?? inner.actorName ?? input.agentName ?? input.actorName ?? "Asesor CRM").trim();
    const shouldPauseBot = (inner.pauseBot ?? input.pauseBot) !== false;

    const normalizedPhone = normalizePhoneDigits(rawPhone);
    if (!normalizedPhone || !text) {
      throw validationError("toPhone y body son obligatorios para despachar WhatsApp desde CRM");
    }

    const isNew = await this.claimIdempotencyKey(idempotencyKey);
    if (!isNew) {
      this.deps.logger.info({ idempotencyKey, waPhone: normalizedPhone }, "mensaje saliente CRM duplicado ignorado");
      return {
        duplicate: true,
        delivered: true,
        conversationId: null,
        messageId: null,
        externalId: null,
        pausedCaseId: null,
      };
    }

    const { conversationRepo, messageRepo, whatsappSender, caseRepo, auditRepo, broadcaster, redisClient, logger } =
      this.deps;

    const conversation =
      redisClient && redisClient.status === "ready"
        ? await withConversationLock(redisClient, normalizedPhone, () =>
            conversationRepo.findOrCreateByWaPhone(normalizedPhone),
          )
        : await conversationRepo.findOrCreateByWaPhone(normalizedPhone);

    const { externalId } = await whatsappSender.sendText(conversation.waPhone, text);

    let activeCaseId = conversation.activeCaseId;
    if (!activeCaseId && caseRepo) {
      const cases = await caseRepo.listByConversation(conversation.id);
      const nonTerminal = cases.find((c) => !TERMINAL_CASE_STATUSES.includes(c.status));
      activeCaseId = nonTerminal?.id ?? null;
    }

    const savedMessage = await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "agent",
      body: text,
      externalId,
      caseId: activeCaseId,
      agentId: null,
      status: "sent",
    });

    await conversationRepo.touchLastActivity(conversation.id);
    broadcaster?.publish({
      type: "MESSAGE_SENT",
      conversationId: conversation.id,
      messageId: savedMessage.id,
      author: "agent",
    });

    let pausedCaseId: string | null = null;
    if (shouldPauseBot && caseRepo && activeCaseId) {
      await caseRepo.setAutomationEnabled(activeCaseId, false, {
        reason: "CRM_HUMAN_HANDOFF",
      });
      await caseRepo.appendEvent(activeCaseId, "AUTOMATION_DISABLED", {
        reason: "CRM_HUMAN_HANDOFF",
        agentName,
      });
      broadcaster?.publish({
        type: "AUTOMATION_DISABLED",
        caseId: activeCaseId,
        conversationId: conversation.id,
      });
      pausedCaseId = activeCaseId;
    }

    await auditRepo?.record({
      action: "CRM_OUTBOUND_WHATSAPP",
      resourceType: "conversation",
      resourceId: conversation.id,
      actorId: null,
      metadata: {
        idempotencyKey: idempotencyKey || null,
        externalId,
        agentName,
        pausedCaseId,
      },
    });

    logger.info(
      {
        conversationId: conversation.id,
        messageId: savedMessage.id,
        externalId,
        pausedCaseId,
        agentName,
      },
      "mensaje saliente enviado desde CRM por canal WhatsApp ISP",
    );

    return {
      duplicate: false,
      delivered: true,
      conversationId: conversation.id,
      messageId: savedMessage.id,
      externalId,
      pausedCaseId,
    };
  }
}
