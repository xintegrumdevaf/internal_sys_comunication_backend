import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../../../../shared/config/env";
import { notFound, validationError, businessError } from "../../../../shared/errors/domain-errors";
import { requireAuth } from "../../../../shared/http/require-auth";
import type { ListConversationsUseCase } from "../application/use-cases/list-conversations.use-case";
import type { SearchConversationsUseCase } from "../application/use-cases/search-conversations.use-case";
import type { ListMessagesUseCase } from "../application/use-cases/list-messages.use-case";
import type { ReplyAsHumanUseCase } from "../application/use-cases/reply-as-human.use-case";
import type { TakeControlUseCase } from "../application/use-cases/take-control.use-case";
import type { DeriveConversationUseCase } from "../application/use-cases/derive-conversation.use-case";
import type { MarkConversationAsReadUseCase } from "../application/use-cases/mark-conversation-as-read.use-case";
import type { ConversationRepositoryPort } from "../application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../application/ports/message.repository.port";
import type { MediaStoragePort } from "../application/ports/media-storage.port";
import type { WhatsAppSenderPort } from "../application/ports/whatsapp-sender.port";
import type { CaseRepositoryPort } from "../../cases/application/ports/case.repository.port";
import type { RealtimeBroadcaster } from "../../realtime/application/realtime-broadcaster";
import type { SystemSettingsService } from "../../settings/application/services/system-settings.service";
import type { MessageTemplateRepositoryPort } from "../../message-templates/application/ports/message-template.repository.port";
import {
  clearMediaMemoryCache,
  maybeParseMultipart,
  proxyMediaRequest,
} from "./media-proxy.helper";
import { executeReplyOrMediaRequest } from "./reply-request.helper";

export type ConversationsRouterDeps = {
  listConversations: ListConversationsUseCase;
  searchConversations?: SearchConversationsUseCase;
  listMessages: ListMessagesUseCase;
  replyAsHuman: ReplyAsHumanUseCase;
  takeControl: TakeControlUseCase;
  deriveConversation?: DeriveConversationUseCase;
  markAsRead: MarkConversationAsReadUseCase;
  caseRepo: CaseRepositoryPort;
  conversationRepo?: ConversationRepositoryPort;
  messageRepo?: MessageRepositoryPort;
  broadcaster?: RealtimeBroadcaster;
  settingsService?: SystemSettingsService;
  whatsappSender?: WhatsAppSenderPort;
  templateRepo?: MessageTemplateRepositoryPort;
  mediaStorage?: MediaStoragePort;
};


const statusSchema = z.enum(["open", "pending", "resolved", "closed"]).optional();

export function _clearMediaCacheForTesting(): void {
  clearMediaMemoryCache();
}

/**
 * docs/spec/03_API_CONTRACT.md §C.1/§C.2 — conversaciones (Etapa 7 completa).
 * Identidad del agente que responde/toma control via sesion real
 * (docs/spec/06_BACKEND_GAPS.md §1.b), no via `agentUserId` en el body.
 */
export function createConversationsRouter(deps: ConversationsRouterDeps): Router {
  const router = Router();
  const { listConversations, listMessages, replyAsHuman, takeControl, deriveConversation, markAsRead, caseRepo } = deps;

  router.get("/api/conversations", async (req, res, next) => {
    try {
      requireAuth(req);
      const status = statusSchema.parse(req.query.status);
      const departmentId =
        typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
      const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
      const conversations = await listConversations.execute({ status, departmentId, userId });
      res.json({ data: conversations });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/conversations/search", async (req, res, next) => {
    try {
      requireAuth(req);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!q || q.length < 2) {
        res.json({ data: [] });
        return;
      }
      const limit = Math.min(Number(req.query.limit) || 25, 50);
      const departmentId =
        typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
      const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;

      const results = deps.searchConversations
        ? await deps.searchConversations.execute({ query: q, limit, departmentId, userId })
        : [];
      res.json({ data: results });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/conversations/:id", async (req, res, next) => {
    try {
      requireAuth(req);
      if (deps.conversationRepo) {
        const conv = await deps.conversationRepo.findById(req.params.id);
        if (!conv) {
          throw notFound(`Conversacion ${req.params.id} no encontrada`);
        }
        let activeCaseDto = null;
        if (caseRepo) {
          const cases = await caseRepo.listByConversation(conv.id);
          const active =
            (conv.activeCaseId ? cases.find((c) => c.id === conv.activeCaseId) : null) ??
            cases.find((c) => c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED") ??
            cases.find((c) => c.status === "ACTIVE" || c.status === "WAITING_USER") ??
            null;
          if (active) {
            const autoState = await caseRepo.getAutomationState(active.id);
            activeCaseDto = {
              id: active.id,
              status: active.status,
              workflowType: active.workflowType,
              departmentId: active.departmentId,
              assignedAgentId: active.assignedAgentId,
              automationEnabled: autoState
                ? autoState.enabled
                : active.status !== "HUMAN_ACTIVE" && active.status !== "ESCALATED",
              disabledReason: autoState?.disabledReason ?? null,
            };
          }
        }
        let lastPreview = null;
        if (deps.messageRepo) {
          const lastMap = await deps.messageRepo.findLastByConversationIds([conv.id]);
          const last = lastMap.get(conv.id);
          if (last) {
            lastPreview = {
              body: last.body,
              author: last.author,
              direction: last.direction,
              createdAt: last.createdAt,
            };
          }
        }
        res.json({
          data: {
            ...conv,
            lastMessagePreview: lastPreview,
            activeCase: activeCaseDto,
          },
        });
        return;
      }

      // Fallback si no está inyectado conversationRepo directamente
      const list = await listConversations.execute({});
      const found = list.find((c) => c.id === req.params.id);
      if (!found) {
        throw notFound(`Conversacion ${req.params.id} no encontrada`);
      }
      res.json({ data: found });
    } catch (error) {
      next(error);
    }
  });


  router.get("/api/conversations/:id/messages", async (req, res, next) => {
    try {
      requireAuth(req);
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const messages = await listMessages.execute(req.params.id, {
        limit: Number.isFinite(limit) ? limit : undefined,
        cursor,
      });
      void markAsRead.execute(req.params.id).catch(() => {});
      res.json({ data: messages });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/conversations/:id/cases", async (req, res, next) => {
    try {
      requireAuth(req);
      const cases = await caseRepo.listByConversation(req.params.id);
      res.json({ data: cases });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/conversations/:id/automation", async (req, res, next) => {
    try {
      requireAuth(req);
      const cases = await caseRepo.listByConversation(req.params.id);
      const active =
        cases.find((c) => c.status === "ACTIVE" || c.status === "WAITING_USER") ??
        cases.find((c) => c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED");
      if (!active) {
        res.json({ data: null });
        return;
      }
      const automation = await caseRepo.getAutomationState(active.id);
      res.json({
        data: automation
          ? {
              caseId: active.id,
              enabled: automation.enabled,
              disabledReason: automation.disabledReason,
            }
          : null,
      });
    } catch (error) {
      next(error);
    }
  });

  const handleReplyOrMedia = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agent = requireAuth(req);
      const result = await executeReplyOrMediaRequest({
        req,
        res,
        conversationId: String(req.params.id),
        agentUserId: agent.id,
        replyAsHuman,
        broadcaster: deps.broadcaster,
      });
      res.status(result.statusCode).json(result.payload);
    } catch (error) {
      next(error);
    }
  };

  router.post("/api/conversations/:id/reply", maybeParseMultipart, handleReplyOrMedia);
  router.post("/api/conversations/:id/media", maybeParseMultipart, handleReplyOrMedia);
  router.post("/api/conversations/:id/attachments", maybeParseMultipart, handleReplyOrMedia);

  const sendTemplateBodySchema = z.object({
    templateName: z.string().min(1),
    languageCode: z.string().optional().default("es"),
    parameters: z.array(z.string()).optional().default([]),
  });

  router.post("/api/conversations/:id/template", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const parsed = sendTemplateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }

      if (!deps.whatsappSender) {
        throw businessError("El canal de WhatsApp no está configurado para envío de plantillas");
      }
      if (!deps.conversationRepo || !deps.messageRepo) {
        throw businessError("Repositorios no disponibles");
      }

      const conversation = await deps.conversationRepo.findById(req.params.id);
      if (!conversation) {
        throw notFound(`Conversación ${req.params.id} no encontrada`);
      }

      // Obtener el texto de la plantilla si está en el repositorio para previsualización en el mensaje
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
        if (active) {
          effectiveCaseId = active.id;
        }
      }

      // Desacople de plantillas: el envío de plantilla saliente no debe forzar un caso
      // HUMAN_ACTIVE ni asignarse como interacción humana de chat 1:1 (agentId: null).
      // Si el cliente responde, la IA debe poder retomar el control de inmediato.
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

  router.post("/api/conversations/:id/take-control", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const result = await takeControl.execute({
        conversationId: req.params.id,
        agentUserId: agent.id,
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/conversations/:id/read", async (req, res, next) => {
    try {
      requireAuth(req);
      await markAsRead.execute(req.params.id);
      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  });

  const openCaseStatuses = new Set([
    "NEW",
    "ACTIVE",
    "WAITING_USER",
    "PAUSED",
    "ESCALATED",
    "HUMAN_ACTIVE",
  ]);

  const deriveBodySchema = z.object({
    toDepartmentId: z.string().uuid(),
    reason: z.string().min(1).optional(),
  });

  router.post("/api/conversations/:id/derive", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      if (!deriveConversation) {
        throw businessError("No se puede derivar la conversación en este momento");
      }
      const parsed = deriveBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError("Debes elegir el área a la que se deriva la conversación");
      }
      const result = await deriveConversation.execute({
        conversationId: req.params.id,
        agentUserId: agent.id,
        toDepartmentId: parsed.data.toDepartmentId,
        reason: parsed.data.reason,
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/conversations/:id/close", async (req, res, next) => {
    try {
      requireAuth(req);
      if (!deps.conversationRepo) {
        throw businessError("No se puede cerrar la conversación en este momento");
      }
      const conversation = await deps.conversationRepo.findById(req.params.id);
      if (!conversation) {
        throw notFound(`Conversacion ${req.params.id} no encontrada`);
      }
      if (conversation.status === "resolved" || conversation.status === "closed") {
        res.json({ data: conversation });
        return;
      }
      const cases = await caseRepo.listByConversation(conversation.id);
      const openCase = cases.find((item) => openCaseStatuses.has(item.status));
      if (openCase) {
        throw businessError(
          "Esta conversación tiene un caso activo. Ciérralo desde el caso para resolverla.",
        );
      }
      await deps.conversationRepo.setStatus(conversation.id, "closed");
      const updated = await deps.conversationRepo.findById(conversation.id);
      res.json({ data: updated ?? { ...conversation, status: "closed" } });
    } catch (error) {
      next(error);
    }
  });

  const handleMediaProxy = (
    req: Parameters<Parameters<typeof router.get>[1]>[0],
    res: Parameters<Parameters<typeof router.get>[1]>[1],
    next: Parameters<Parameters<typeof router.get>[1]>[2],
  ) => {
    void proxyMediaRequest(req, res, next, {
      env,
      settingsService: deps.settingsService,
      mediaStorage: deps.mediaStorage,
      ensureAuth: (request, zernioMedia) => {
        if (!request.agent && !zernioMedia) {
          try {
            requireAuth(request);
          } catch (e) {
            if (process.env.NODE_ENV === "production" && !request.headers.referer?.includes("localhost")) {
              throw e;
            }
          }
        }
      },
    });
  };

  router.get("/api/media", handleMediaProxy);
  router.get("/api/media/:mediaId", handleMediaProxy);
  router.get("/api/media/*path", handleMediaProxy);

  return router;
}
