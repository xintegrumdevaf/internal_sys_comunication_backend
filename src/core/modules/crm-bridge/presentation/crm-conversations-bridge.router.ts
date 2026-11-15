import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { Env } from "../../../../shared/config/env";
import { businessError, notFound, validationError } from "../../../../shared/errors/domain-errors";
import { normalizePhoneDigits } from "../../../../shared/http/crm-signature";
import type { CaseRepositoryPort } from "../../cases/application/ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../conversations/application/ports/conversation.repository.port";
import type { MediaStoragePort } from "../../conversations/application/ports/media-storage.port";
import type { MessageRepositoryPort } from "../../conversations/application/ports/message.repository.port";
import type { WhatsAppSenderPort } from "../../conversations/application/ports/whatsapp-sender.port";
import type { ListConversationsUseCase } from "../../conversations/application/use-cases/list-conversations.use-case";
import type { ListMessagesUseCase } from "../../conversations/application/use-cases/list-messages.use-case";
import type { MarkConversationAsReadUseCase } from "../../conversations/application/use-cases/mark-conversation-as-read.use-case";
import type { ReplyAsHumanUseCase } from "../../conversations/application/use-cases/reply-as-human.use-case";
import { maybeParseMultipart, proxyMediaRequest } from "../../conversations/presentation/media-proxy.helper";
import { executeReplyOrMediaRequest } from "../../conversations/presentation/reply-request.helper";
import type {
  ListMessageTemplatesFilter,
  MessageTemplateRepositoryPort,
} from "../../message-templates/application/ports/message-template.repository.port";
import type { QuickReplyRepositoryPort } from "../../quick-replies/application/ports/quick-reply.repository.port";
import type { RealtimeBroadcaster } from "../../realtime/application/realtime-broadcaster";
import type { SystemSettingsService } from "../../settings/application/services/system-settings.service";

export interface CrmConversationsBridgeDeps {
  listConversations?: ListConversationsUseCase;
  listMessages?: ListMessagesUseCase;
  replyAsHuman?: ReplyAsHumanUseCase;
  markAsRead?: MarkConversationAsReadUseCase;
  conversationRepo?: ConversationRepositoryPort;
  messageRepo?: MessageRepositoryPort;
  caseRepo?: CaseRepositoryPort;
  whatsappSender?: WhatsAppSenderPort;
  templateRepo?: MessageTemplateRepositoryPort;
  quickReplyRepo?: QuickReplyRepositoryPort;
  mediaStorage?: MediaStoragePort;
  settingsService?: SystemSettingsService;
  broadcaster?: RealtimeBroadcaster;
}

const sendTemplateSchema = z.object({
  templateName: z.string().min(1),
  languageCode: z.string().optional().default("es"),
  parameters: z.array(z.string()).optional().default([]),
});

function rejectUnauthorized(res: Response): void {
  res.status(401).json({
    error: {
      code: "UNAUTHORIZED",
      message: "Firma HMAC X-Crm-Signature o clave interna inválida",
    },
  });
}

function phoneTail10(raw?: string | null): string {
  const digits = normalizePhoneDigits(raw || "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function registerCrmConversationsBridgeRoutes(
  router: Router,
  env: Env,
  isAuthorized: (req: Request, env: Env) => boolean,
  deps: CrmConversationsBridgeDeps,
): void {
  const requireBridgeAuth = (req: Request, res: Response): boolean => {
    if (!isAuthorized(req, env)) {
      req.log?.warn({ path: req.path }, "petición puente CRM rechazada por autenticación");
      rejectUnauthorized(res);
      return false;
    }
    return true;
  };

  router.get("/api/crm/conversations", async (req, res, next) => {
    try {
      if (!requireBridgeAuth(req, res)) return;
      if (!deps.listConversations) {
        res.json({ data: [] });
        return;
      }
      const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
      const status =
        rawStatus === "open" || rawStatus === "pending" || rawStatus === "resolved" || rawStatus === "closed"
          ? rawStatus
          : undefined;
      const conversations = await deps.listConversations.execute({ status });

      const rawPhones = typeof req.query.phones === "string" ? req.query.phones : "";
      if (!rawPhones.trim()) {
        res.json({ data: conversations });
        return;
      }
      const targetTails = new Set(
        rawPhones
          .split(",")
          .map((p) => phoneTail10(p))
          .filter(Boolean),
      );
      const filtered = conversations.filter((conv) => targetTails.has(phoneTail10(conv.waPhone)));
      res.json({ data: filtered });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/crm/conversations/:id/messages", async (req, res, next) => {
    try {
      if (!requireBridgeAuth(req, res)) return;
      if (!deps.listMessages || !deps.conversationRepo) {
        throw businessError("Servicio de mensajes no disponible");
      }
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const effectiveLimit = Number.isFinite(limit) && limit && limit > 0 ? Math.min(limit, 100) : 50;

      const conversation = await deps.conversationRepo.findById(String(req.params.id));
      if (!conversation) {
        throw notFound(`Conversacion ${String(req.params.id)} no encontrada`);
      }

      const messages = await deps.listMessages.execute(conversation.id, {
        limit: effectiveLimit,
        cursor,
      });

      res.json({
        data: messages,
        meta: {
          conversation,
          hasMore: messages.length >= effectiveLimit,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/crm/conversations/:id/read", async (req, res, next) => {
    try {
      if (!requireBridgeAuth(req, res)) return;
      if (!deps.markAsRead) {
        throw businessError("Servicio markAsRead no disponible");
      }
      await deps.markAsRead.execute(String(req.params.id));
      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/crm/conversations/:id/reply", maybeParseMultipart, async (req, res, next) => {
    try {
      if (!requireBridgeAuth(req, res)) return;
      if (!deps.replyAsHuman) {
        throw businessError("Servicio replyAsHuman no disponible");
      }
      const bodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const actorName =
        (typeof bodyObj.actorName === "string" ? bodyObj.actorName : undefined) ??
        (typeof bodyObj.agentName === "string" ? bodyObj.agentName : undefined);

      const result = await executeReplyOrMediaRequest({
        req,
        res,
        conversationId: String(req.params.id),
        agentUserId: null,
        actorName,
        skipCrmSync: true,
        replyAsHuman: deps.replyAsHuman,
        broadcaster: deps.broadcaster,
      });
      res.status(result.statusCode).json(result.payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/crm/conversations/by-phone/:phone/reply", maybeParseMultipart, async (req, res, next) => {
    try {
      if (!requireBridgeAuth(req, res)) return;
      if (!deps.replyAsHuman || !deps.conversationRepo) {
        throw businessError("Servicio replyAsHuman/conversationRepo no disponible");
      }
      const normalized = normalizePhoneDigits(String(req.params.phone || ""));
      if (!normalized) {
        throw validationError("Teléfono inválido para enviar mensaje");
      }
      const conversation = await deps.conversationRepo.findOrCreateByWaPhone(normalized);
      const bodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const actorName =
        (typeof bodyObj.actorName === "string" ? bodyObj.actorName : undefined) ??
        (typeof bodyObj.agentName === "string" ? bodyObj.agentName : undefined);

      const result = await executeReplyOrMediaRequest({
        req,
        res,
        conversationId: conversation.id,
        agentUserId: null,
        actorName,
        skipCrmSync: true,
        replyAsHuman: deps.replyAsHuman,
        broadcaster: deps.broadcaster,
      });
      res.status(result.statusCode).json({
        ...result.payload,
        conversation,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/crm/conversations/:id/template", async (req, res, next) => {
    try {
      if (!requireBridgeAuth(req, res)) return;
      const parsed = sendTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      if (!deps.whatsappSender || !deps.conversationRepo || !deps.messageRepo) {
        throw businessError("El canal de WhatsApp no está configurado para envío de plantillas");
      }
      const conversation = await deps.conversationRepo.findById(String(req.params.id));
      if (!conversation) {
        throw notFound(`Conversación ${String(req.params.id)} no encontrada`);
      }

      let templateBodyText = `📋 [Plantilla: ${parsed.data.templateName}]`;
      if (deps.templateRepo) {
        const tpl = await deps.templateRepo.findByName(parsed.data.templateName);
        if (tpl?.bodyText) {
          let replacedText = tpl.bodyText;
          (parsed.data.parameters || []).forEach((param, idx) => {
            replacedText = replacedText.replace(new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g"), param);
          });
          templateBodyText = replacedText;
        }
      }

      const { externalId } = await deps.whatsappSender.sendTemplate(
        conversation.waPhone,
        parsed.data.templateName,
        parsed.data.languageCode,
        parsed.data.parameters,
      );

      let effectiveCaseId = conversation.activeCaseId;
      if (!effectiveCaseId && deps.caseRepo) {
        const cases = await deps.caseRepo.listByConversation(conversation.id);
        const active =
          cases.find((c) => c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED") ??
          cases.find((c) => c.status === "ACTIVE" || c.status === "WAITING_USER") ??
          cases.find((c) => c.status === "NEW");
        if (active) effectiveCaseId = active.id;
      }

      const message = await deps.messageRepo.insertOutbound({
        conversationId: conversation.id,
        author: "agent",
        body: templateBodyText,
        externalId,
        agentId: null,
        caption: `template:${parsed.data.templateName}`,
        caseId: effectiveCaseId ?? undefined,
      });

      await deps.conversationRepo.touchLastActivity(conversation.id);
      deps.broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: message.conversationId,
        messageId: message.id,
        author: "agent",
      });

      res.status(201).json({ data: message });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/crm/templates", async (req, res, next) => {
    try {
      if (!requireBridgeAuth(req, res)) return;
      if (!deps.templateRepo) {
        res.json({ data: { templates: [], total: 0 } });
        return;
      }
      const status = typeof req.query.status === "string"
        ? (req.query.status as ListMessageTemplatesFilter["status"])
        : "APPROVED";
      const category = typeof req.query.category === "string"
        ? (req.query.category as ListMessageTemplatesFilter["category"])
        : undefined;
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const data = await deps.templateRepo.list({ status, category, search });
      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/crm/quick-replies", async (req, res, next) => {
    try {
      if (!requireBridgeAuth(req, res)) return;
      if (!deps.quickReplyRepo) {
        res.json({ quickReplies: [] });
        return;
      }
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      const quickReplies = await deps.quickReplyRepo.list({
        activeOnly: true,
        search,
        category,
      });
      res.json({ quickReplies });
    } catch (error) {
      next(error);
    }
  });

  const handleBridgeMediaProxy = (req: Request, res: Response, next: (err?: unknown) => void) => {
    if (!requireBridgeAuth(req, res)) return;
    void proxyMediaRequest(req, res, next, {
      env,
      settingsService: deps.settingsService,
      mediaStorage: deps.mediaStorage,
    });
  };

  router.get("/api/crm/media", handleBridgeMediaProxy);
  router.get("/api/crm/media/:mediaId", handleBridgeMediaProxy);
  router.get("/api/crm/media/*path", handleBridgeMediaProxy);
}
