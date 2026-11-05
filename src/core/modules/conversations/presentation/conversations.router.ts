import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../../../../shared/config/env";
import { notFound, validationError, businessError } from "../../../../shared/errors/domain-errors";
import { requireAuth } from "../../../../shared/http/require-auth";
import { emptyContextFor } from "../../cases/domain/contexts/case-context";
import type { ListConversationsUseCase } from "../application/use-cases/list-conversations.use-case";
import type { SearchConversationsUseCase } from "../application/use-cases/search-conversations.use-case";
import type { ListMessagesUseCase } from "../application/use-cases/list-messages.use-case";
import type {
  ReplyAsHumanMediaInput,
  ReplyAsHumanUseCase,
} from "../application/use-cases/reply-as-human.use-case";
import type { TakeControlUseCase } from "../application/use-cases/take-control.use-case";
import type { DeriveConversationUseCase } from "../application/use-cases/derive-conversation.use-case";
import type { MarkConversationAsReadUseCase } from "../application/use-cases/mark-conversation-as-read.use-case";
import type { ConversationRepositoryPort } from "../application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../application/ports/message.repository.port";
import type { MediaStoragePort } from "../application/ports/media-storage.port";
import type { WhatsAppMediaType, WhatsAppSenderPort } from "../application/ports/whatsapp-sender.port";
import type { CaseRepositoryPort } from "../../cases/application/ports/case.repository.port";
import type { RealtimeBroadcaster } from "../../realtime/application/realtime-broadcaster";
import type { SystemSettingsService } from "../../settings/application/services/system-settings.service";
import type { MessageTemplateRepositoryPort } from "../../message-templates/application/ports/message-template.repository.port";
import {
  inferContentType,
  isZernioMediaUrl,
  unwrapOwnMediaTarget,
} from "../infrastructure/storage/local-media-storage.adapter";

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

interface CachedMediaItem {
  buffer: Buffer;
  contentType: string | null;
  timestamp: number;
}

const mediaMemoryCache = new Map<string, CachedMediaItem>();
const MAX_CACHE_ENTRIES = 300;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCachedMedia(key: string): CachedMediaItem | null {
  const cached = mediaMemoryCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    mediaMemoryCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedMedia(key: string, buffer: Buffer, contentType: string | null) {
  if (mediaMemoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = mediaMemoryCache.keys().next().value;
    if (oldestKey) mediaMemoryCache.delete(oldestKey);
  }
  mediaMemoryCache.set(key, { buffer, contentType, timestamp: Date.now() });
}

export function _clearMediaCacheForTesting(): void {
  mediaMemoryCache.clear();
}

function sendMediaResponse(
  req: Request,
  res: Response,
  buffer: Buffer,
  rawContentType: string | null,
  targetUrl: string,
) {
  const contentType = inferContentType(rawContentType, targetUrl);

  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  const totalLength = buffer.length;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : totalLength - 1;

      if (start >= totalLength || end >= totalLength || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${totalLength}`);
        res.end();
        return;
      }

      const chunk = buffer.subarray(start, end + 1);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${totalLength}`);
      res.setHeader("Content-Length", chunk.length);
      res.send(chunk);
      return;
    }
  }

  res.setHeader("Content-Length", totalLength);
  res.send(buffer);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB (límite máximo de documentos en WhatsApp)
});

function maybeParseMultipart(req: Request, res: Response, next: NextFunction): void {
  const contentType = req.headers["content-type"] || "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    upload.any()(req, res, (err) => {
      if (err) {
        next(validationError(`Error al procesar archivo adjunto: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      next();
    });
    return;
  }
  next();
}

function normalizeUploadedFilename(rawName?: string): string | undefined {
  if (!rawName) return undefined;
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;
  try {
    // Multer/busboy decodifica headers multipart como latin1 por defecto
    const utf8 = Buffer.from(trimmed, "latin1").toString("utf8");
    if (!utf8.includes("\uFFFD")) {
      return utf8;
    }
  } catch {
    // fallback a original
  }
  return trimmed;
}

function parseBase64Payload(raw: string, fallbackMime?: string): { buffer: Buffer; mimeType?: string } {
  const trimmed = raw.trim();
  const dataUrlMatch = trimmed.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    const detectedMime = dataUrlMatch[1]?.trim() || fallbackMime;
    const base64Data = dataUrlMatch[2]?.replace(/\s+/g, "") || "";
    return {
      buffer: Buffer.from(base64Data, "base64"),
      mimeType: detectedMime,
    };
  }
  return {
    buffer: Buffer.from(trimmed.replace(/\s+/g, ""), "base64"),
    mimeType: fallbackMime,
  };
}

function extractJsonMediaInputs(bodyObj: Record<string, unknown>): Array<{
  media: ReplyAsHumanMediaInput;
  caption?: string;
}> {
  const results: Array<{ media: ReplyAsHumanMediaInput; caption?: string }> = [];

  const parseSingleItem = (item: Record<string, unknown>, fallbackCaption?: string) => {
    const rawData =
      (typeof item.data === "string" ? item.data : undefined) ??
      (typeof item.base64 === "string" ? item.base64 : undefined) ??
      (typeof item.fileBase64 === "string" ? item.fileBase64 : undefined) ??
      (typeof item.dataUrl === "string" ? item.dataUrl : undefined) ??
      (typeof item.mediaData === "string" ? item.mediaData : undefined);

    const mediaUrl =
      (typeof item.mediaUrl === "string" ? item.mediaUrl : undefined) ??
      (typeof item.attachmentUrl === "string" ? item.attachmentUrl : undefined) ??
      (typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : undefined);

    const rawMime =
      (typeof item.mimeType === "string" ? item.mimeType : undefined) ??
      (typeof item.contentType === "string" ? item.contentType : undefined);

    const rawFilename =
      (typeof item.filename === "string" ? item.filename : undefined) ??
      (typeof item.fileName === "string" ? item.fileName : undefined) ??
      (typeof item.name === "string" ? item.name : undefined);

    const rawType =
      (typeof item.type === "string" ? item.type : undefined) ??
      (typeof item.attachmentType === "string" ? item.attachmentType : undefined) ??
      (typeof item.mediaType === "string" ? item.mediaType : undefined);

    const itemCaption =
      (typeof item.caption === "string" ? item.caption : undefined) ?? fallbackCaption;

    const voiceNote = item.voiceNote === true || item.voiceNote === "true";

    if (rawData) {
      const { buffer, mimeType } = parseBase64Payload(rawData, rawMime);
      if (buffer.length > 0) {
        results.push({
          media: {
            buffer,
            mimeType: mimeType || rawMime,
            filename: rawFilename,
            type: rawType as WhatsAppMediaType | "file" | undefined,
            mediaUrl,
            voiceNote,
          },
          caption: itemCaption,
        });
      }
    } else if (mediaUrl) {
      results.push({
        media: {
          buffer: Buffer.alloc(0),
          mimeType: rawMime,
          filename: rawFilename,
          type: rawType as WhatsAppMediaType | "file" | undefined,
          mediaUrl,
          voiceNote,
        },
        caption: itemCaption,
      });
    }
  };

  const topCaption =
    (typeof bodyObj.caption === "string" ? bodyObj.caption : undefined) ??
    (typeof bodyObj.body === "string" ? bodyObj.body : undefined) ??
    (typeof bodyObj.message === "string" ? bodyObj.message : undefined);

  if (Array.isArray(bodyObj.attachments)) {
    bodyObj.attachments.forEach((att, idx) => {
      if (att && typeof att === "object") {
        parseSingleItem(att as Record<string, unknown>, idx === 0 ? topCaption : undefined);
      }
    });
  } else if (bodyObj.attachment && typeof bodyObj.attachment === "object") {
    parseSingleItem(bodyObj.attachment as Record<string, unknown>, topCaption);
  } else if (bodyObj.media && typeof bodyObj.media === "object") {
    parseSingleItem(bodyObj.media as Record<string, unknown>, topCaption);
  } else {
    parseSingleItem(bodyObj, topCaption);
  }

  return results;
}

const replyBodySchema = z.object({
  body: z.string().min(1),
});

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
      const conversationId = String(req.params.id);
      const rawBodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<
        string,
        unknown
      >;

      const uploadedFiles: Express.Multer.File[] = [];
      if (req.file) {
        uploadedFiles.push(req.file);
      }
      if (Array.isArray(req.files)) {
        uploadedFiles.push(...req.files);
      } else if (req.files && typeof req.files === "object") {
        for (const list of Object.values(req.files)) {
          if (Array.isArray(list)) {
            uploadedFiles.push(...list);
          }
        }
      }

      const textOrCaption =
        (typeof rawBodyObj.caption === "string" ? rawBodyObj.caption : undefined) ??
        (typeof rawBodyObj.body === "string" ? rawBodyObj.body : undefined) ??
        (typeof rawBodyObj.message === "string" ? rawBodyObj.message : undefined) ??
        (typeof rawBodyObj.text === "string" ? rawBodyObj.text : undefined);

      const explicitType =
        (typeof rawBodyObj.type === "string" ? rawBodyObj.type : undefined) ??
        (typeof rawBodyObj.attachmentType === "string" ? rawBodyObj.attachmentType : undefined) ??
        (typeof rawBodyObj.mediaType === "string" ? rawBodyObj.mediaType : undefined);

      const explicitFilename =
        (typeof rawBodyObj.filename === "string" ? rawBodyObj.filename : undefined) ??
        (typeof rawBodyObj.fileName === "string" ? rawBodyObj.fileName : undefined);

      const explicitMimeType =
        (typeof rawBodyObj.mimeType === "string" ? rawBodyObj.mimeType : undefined) ??
        (typeof rawBodyObj.contentType === "string" ? rawBodyObj.contentType : undefined);

      const voiceNote = rawBodyObj.voiceNote === true || rawBodyObj.voiceNote === "true";

      // 1. Archivos subidos vía multipart/form-data
      if (uploadedFiles.length > 0) {
        const sentMessages = [];
        for (let i = 0; i < uploadedFiles.length; i++) {
          const file = uploadedFiles[i]!;
          const filename =
            (uploadedFiles.length === 1 && explicitFilename ? explicitFilename : undefined) ||
            normalizeUploadedFilename(file.originalname) ||
            `adjunto-${Date.now()}`;
          const mimeType = explicitMimeType || file.mimetype || "application/octet-stream";
          const captionForThisFile = i === 0 ? textOrCaption : undefined;

          const message = await replyAsHuman.execute({
            conversationId,
            agentUserId: agent.id,
            body: captionForThisFile,
            caption: captionForThisFile,
            media: {
              buffer: file.buffer,
              mimeType,
              filename,
              type: explicitType as WhatsAppMediaType | "file" | undefined,
              voiceNote,
            },
          });

          deps.broadcaster?.publish({
            type: "MESSAGE_SENT",
            conversationId: message.conversationId,
            messageId: message.id,
            author: "agent",
          });
          sentMessages.push(message);
        }

        res.status(201).json({
          data: sentMessages[sentMessages.length - 1],
          ...(sentMessages.length > 1 ? { messages: sentMessages } : {}),
        });
        return;
      }

      // 2. Archivos adjuntos enviados en JSON (base64 / dataUrl / attachmentUrl)
      const jsonMediaItems = extractJsonMediaInputs(rawBodyObj);
      if (jsonMediaItems.length > 0) {
        const sentMessages = [];
        for (const item of jsonMediaItems) {
          const message = await replyAsHuman.execute({
            conversationId,
            agentUserId: agent.id,
            body: item.caption,
            caption: item.caption,
            media: item.media,
          });
          deps.broadcaster?.publish({
            type: "MESSAGE_SENT",
            conversationId: message.conversationId,
            messageId: message.id,
            author: "agent",
          });
          sentMessages.push(message);
        }

        res.status(201).json({
          data: sentMessages[sentMessages.length - 1],
          ...(sentMessages.length > 1 ? { messages: sentMessages } : {}),
        });
        return;
      }

      // 3. Respuesta de texto tradicional
      const parsed = replyBodySchema.safeParse({
        body: textOrCaption ?? rawBodyObj.body,
      });
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }

      const message = await replyAsHuman.execute({
        conversationId,
        agentUserId: agent.id,
        body: parsed.data.body,
      });
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
        } else {
          const newCase = await deps.caseRepo.create({
            conversationId: conversation.id,
            workflowType: "GENERAL_INQUIRY",
            departmentId: null,
            context: emptyContextFor("GENERAL_INQUIRY"),
            initialState: "HUMAN_DIRECT",
            expiresAt: null,
          });
          effectiveCaseId = newCase.case.id;
          await deps.caseRepo.setAssignedAgent(effectiveCaseId, agent.id);
          await deps.caseRepo.applyTransition({
            caseId: effectiveCaseId,
            expectedCaseVersion: newCase.case.version,
            expectedWorkflowVersion: newCase.workflowInstance.version,
            status: "HUMAN_ACTIVE",
            context: newCase.case.context,
            currentState: newCase.workflowInstance.currentState,
            expiresAt: null,
          });
          await deps.conversationRepo.setActiveCaseId(conversation.id, effectiveCaseId);
        }
      }

      const message = await deps.messageRepo.insertOutbound({
        conversationId: conversation.id,
        author: "agent",
        body: templateBodyText,
        externalId,
        agentId: agent.id,
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

  const handleMediaProxy = async (req: Parameters<Parameters<typeof router.get>[1]>[0], res: Parameters<Parameters<typeof router.get>[1]>[1], next: Parameters<Parameters<typeof router.get>[1]>[2]) => {
    try {
      const paramTarget = (req.params as Record<string, unknown>).path ?? req.params[0] ?? (req.params as Record<string, unknown>).mediaId;
      let rawTarget = (req.query.url as string) || (Array.isArray(paramTarget) ? paramTarget.join("/") : (paramTarget as string));
      if (!rawTarget) {
        res.status(400).json({ error: "Parametro mediaId o url es requerido" });
        return;
      }

      rawTarget = unwrapOwnMediaTarget(rawTarget);
      let decodedTarget = decodeURIComponent(rawTarget);

      if (/^https?:\/+[^\/]/i.test(decodedTarget)) {
        decodedTarget = decodedTarget.replace(/^(https?):\/*/, "$1://");
      }

      let isUrl = /^https?:\/\//i.test(decodedTarget);
      let resolvedUrl = decodedTarget;

      if (decodedTarget.includes("zernio.com")) {
        const idx = decodedTarget.indexOf("zernio.com");
        resolvedUrl = "https://" + decodedTarget.substring(idx);
        isUrl = true;
      } else if (
        decodedTarget.includes("zernio") ||
        decodedTarget.startsWith("/api/v1/") ||
        decodedTarget.startsWith("api/v1/") ||
        decodedTarget.startsWith("/whatsapp/") ||
        decodedTarget.startsWith("whatsapp/")
      ) {
        const baseUrl = (env.ZERNIO_BASE_URL || "https://zernio.com/api/v1").replace(/\/$/, "");
        let cleanPath = decodedTarget;
        if (!cleanPath.startsWith("/")) cleanPath = "/" + cleanPath;

        if (cleanPath.startsWith("/api/v1/")) {
          resolvedUrl = `${baseUrl.replace(/\/api\/v1$/, "")}${cleanPath}`;
        } else {
          resolvedUrl = `${baseUrl}${cleanPath}`;
        }
        isUrl = true;
      }

      const mediaTarget = decodedTarget;

      if (isUrl) {
        const queryKeys = Object.keys(req.query).filter((k) => k !== "url");
        if (queryKeys.length > 0) {
          try {
            const urlObj = new URL(resolvedUrl);
            for (const k of queryKeys) {
              if (typeof req.query[k] === "string" && !urlObj.searchParams.has(k)) {
                urlObj.searchParams.set(k, req.query[k] as string);
              }
            }
            resolvedUrl = urlObj.toString();
          } catch {
            // Ignorar errores de parsing de URL
          }
        }

        let zernioApiKey = env.ZERNIO_API_KEY || "";
        let zernioAccountId = env.ZERNIO_ACCOUNT_ID || "";
        let zernioBaseUrl = env.ZERNIO_BASE_URL || "https://zernio.com/api/v1";
        if (deps.settingsService) {
          try {
            const s = await deps.settingsService.getChannelSettings();
            if (s.zernioApiKey) zernioApiKey = s.zernioApiKey;
            if (s.zernioAccountId) zernioAccountId = s.zernioAccountId.trim();
            if (s.zernioBaseUrl) zernioBaseUrl = s.zernioBaseUrl.trim();
          } catch {
            // fallback a env
          }
        }

        const zernioBase = zernioBaseUrl.replace(/\/$/, "");
        const zernioMedia = isZernioMediaUrl(resolvedUrl, zernioBase);
        if (!req.agent && !zernioMedia) {
          try {
            requireAuth(req);
          } catch (e) {
            if (process.env.NODE_ENV === "production" && !req.headers.referer?.includes("localhost")) {
              throw e;
            }
          }
        }

        if (deps.mediaStorage) {
          const persisted = await deps.mediaStorage.get(resolvedUrl);
          if (persisted) {
            sendMediaResponse(req, res, persisted.buffer, persisted.contentType, resolvedUrl);
            return;
          }
        }

        const cached = getCachedMedia(resolvedUrl);
        if (cached) {
          sendMediaResponse(req, res, cached.buffer, cached.contentType, resolvedUrl);
          return;
        }

        const headers: Record<string, string> = {};
        if (zernioApiKey && zernioMedia) {
          headers["Authorization"] = `Bearer ${zernioApiKey}`;
        }
        let fileRes = await fetch(resolvedUrl, { headers });

        if (!fileRes.ok && (fileRes.status === 404 || fileRes.status === 400) && zernioMedia && zernioAccountId) {
          try {
            const retryUrlObj = new URL(resolvedUrl);
            if (retryUrlObj.searchParams.get("accountId") !== zernioAccountId) {
              retryUrlObj.searchParams.set("accountId", zernioAccountId);
              const retryRes = await fetch(retryUrlObj.toString(), { headers });
              if (retryRes.ok) {
                fileRes = retryRes;
              }
            }
          } catch {
            // Ignorar error de parsing en reintento
          }
        }

        if (!fileRes.ok && !zernioMedia && Object.keys(headers).length > 0) {
          fileRes = await fetch(resolvedUrl);
        }

        if (!fileRes.ok) {
          let errMsg = "No se pudo descargar el archivo de la URL";
          try {
            const errJson = (await fileRes.clone().json()) as { error?: string; message?: string };
            if (errJson.error) {
              errMsg = errJson.error;
            } else if (errJson.message) {
              errMsg = errJson.message;
            }
          } catch {
            // Ignorar si no es JSON
          }
          res.status(fileRes.status).json({ error: errMsg });
          return;
        }
        const contentType = fileRes.headers.get("content-type");
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        if (deps.mediaStorage) {
          await deps.mediaStorage.save(resolvedUrl, buffer, contentType);
        } else {
          setCachedMedia(resolvedUrl, buffer, contentType);
        }
        sendMediaResponse(req, res, buffer, contentType, resolvedUrl);
        return;
      }

      if (!req.agent) {
        try {
          requireAuth(req);
        } catch (e) {
          if (process.env.NODE_ENV === "production" && !req.headers.referer?.includes("localhost")) {
            throw e;
          }
        }
      }

      if (deps.mediaStorage) {
        const persistedMeta = await deps.mediaStorage.get(mediaTarget);
        if (persistedMeta) {
          sendMediaResponse(req, res, persistedMeta.buffer, persistedMeta.contentType, mediaTarget);
          return;
        }
      }

      const cachedMeta = getCachedMedia(mediaTarget);
      if (cachedMeta) {
        sendMediaResponse(req, res, cachedMeta.buffer, cachedMeta.contentType, mediaTarget);
        return;
      }

      let whatsappAccessToken = env.WHATSAPP_ACCESS_TOKEN;
      if (deps.settingsService) {
        try {
          const s = await deps.settingsService.getChannelSettings();
          if (s.accessToken) whatsappAccessToken = s.accessToken;
        } catch {
          // fallback a env
        }
      }

      if (!whatsappAccessToken) {
        res.status(503).json({ error: "WHATSAPP_ACCESS_TOKEN no configurado" });
        return;
      }
      const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaTarget}`, {
        headers: { Authorization: `Bearer ${whatsappAccessToken}` },
      });
      if (!metaRes.ok) {
        res.status(metaRes.status).json({ error: "No se pudo obtener metadata del archivo" });
        return;
      }
      const metaJson = (await metaRes.json()) as { url: string; mime_type?: string };
      const fileRes = await fetch(metaJson.url, {
        headers: { Authorization: `Bearer ${whatsappAccessToken}` },
      });
      if (!fileRes.ok) {
        res.status(fileRes.status).json({ error: "No se pudo descargar el archivo" });
        return;
      }
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      if (deps.mediaStorage) {
        await deps.mediaStorage.save(mediaTarget, buffer, metaJson.mime_type || null);
      } else {
        setCachedMedia(mediaTarget, buffer, metaJson.mime_type || null);
      }
      sendMediaResponse(req, res, buffer, metaJson.mime_type || null, mediaTarget);
    } catch (error) {
      next(error);
    }
  };

  router.get("/api/media", handleMediaProxy);
  router.get("/api/media/:mediaId", handleMediaProxy);
  router.get("/api/media/*path", handleMediaProxy);

  return router;
}
