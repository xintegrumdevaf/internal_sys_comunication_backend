import { Router } from "express";
import { z } from "zod";
import { env } from "../../../../shared/config/env";
import { validationError } from "../../../../shared/errors/domain-errors";
import { requireAuth } from "../../../../shared/http/require-auth";
import type { ListConversationsUseCase } from "../application/use-cases/list-conversations.use-case";
import type { ListMessagesUseCase } from "../application/use-cases/list-messages.use-case";
import type { ReplyAsHumanUseCase } from "../application/use-cases/reply-as-human.use-case";
import type { TakeControlUseCase } from "../application/use-cases/take-control.use-case";
import type { MarkConversationAsReadUseCase } from "../application/use-cases/mark-conversation-as-read.use-case";
import type { CaseRepositoryPort } from "../../cases/application/ports/case.repository.port";
import type { RealtimeBroadcaster } from "../../realtime/application/realtime-broadcaster";

export type ConversationsRouterDeps = {
  listConversations: ListConversationsUseCase;
  listMessages: ListMessagesUseCase;
  replyAsHuman: ReplyAsHumanUseCase;
  takeControl: TakeControlUseCase;
  markAsRead: MarkConversationAsReadUseCase;
  caseRepo: CaseRepositoryPort;
  broadcaster?: RealtimeBroadcaster;
};

const statusSchema = z.enum(["open", "pending", "resolved", "closed"]).optional();

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
  const { listConversations, listMessages, replyAsHuman, takeControl, markAsRead, caseRepo } = deps;

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

  router.post("/api/conversations/:id/reply", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const parsed = replyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }

      const message = await replyAsHuman.execute({
        conversationId: req.params.id,
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

  const handleMediaProxy = async (req: Parameters<Parameters<typeof router.get>[1]>[0], res: Parameters<Parameters<typeof router.get>[1]>[1], next: Parameters<Parameters<typeof router.get>[1]>[2]) => {
    try {
      requireAuth(req);
      const paramTarget = (req.params as Record<string, unknown>).path ?? req.params[0] ?? (req.params as Record<string, unknown>).mediaId;
      let rawTarget = (req.query.url as string) || (Array.isArray(paramTarget) ? paramTarget.join("/") : (paramTarget as string));
      if (!rawTarget) {
        res.status(400).json({ error: "Parametro mediaId o url es requerido" });
        return;
      }
      if (!rawTarget.startsWith("/") && !/^https?:\/\//i.test(rawTarget) && (rawTarget.startsWith("api/v1/") || rawTarget.includes("whatsapp/media/"))) {
        rawTarget = "/" + rawTarget;
      }
      const mediaTarget = decodeURIComponent(rawTarget);
      let isUrl = /^https?:\/\//i.test(mediaTarget);
      let resolvedUrl = mediaTarget;

      if (mediaTarget.includes("zernio") || mediaTarget.startsWith("/api/v1/") || mediaTarget.startsWith("/whatsapp/")) {
        const baseUrl = (env.ZERNIO_BASE_URL || "https://zernio.com/api/v1").replace(/\/$/, "");
        if (mediaTarget.startsWith("/api/v1/")) {
          resolvedUrl = `${baseUrl.replace(/\/api\/v1$/, "")}${mediaTarget}`;
          isUrl = true;
        } else if (mediaTarget.startsWith("/")) {
          resolvedUrl = `${baseUrl}${mediaTarget}`;
          isUrl = true;
        }
      }

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

        const headers: Record<string, string> = {};
        if (env.ZERNIO_API_KEY && (resolvedUrl.includes("zernio") || env.WHATSAPP_PROVIDER === "zernio")) {
          headers["Authorization"] = `Bearer ${env.ZERNIO_API_KEY}`;
        }
        let fileRes = await fetch(resolvedUrl, { headers });
        if (!fileRes.ok && Object.keys(headers).length > 0) {
          fileRes = await fetch(resolvedUrl);
        }
        if (!fileRes.ok) {
          res.status(fileRes.status).json({ error: "No se pudo descargar el archivo de la URL" });
          return;
        }
        const contentType = fileRes.headers.get("content-type");
        if (contentType) {
          res.setHeader("Content-Type", contentType);
        }
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        res.send(buffer);
        return;
      }

      if (!env.WHATSAPP_ACCESS_TOKEN) {
        res.status(503).json({ error: "WHATSAPP_ACCESS_TOKEN no configurado" });
        return;
      }
      const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaTarget}`, {
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      });
      if (!metaRes.ok) {
        res.status(metaRes.status).json({ error: "No se pudo obtener metadata del archivo" });
        return;
      }
      const metaJson = (await metaRes.json()) as { url: string; mime_type?: string };
      const fileRes = await fetch(metaJson.url, {
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      });
      if (!fileRes.ok) {
        res.status(fileRes.status).json({ error: "No se pudo descargar el archivo" });
        return;
      }
      if (metaJson.mime_type) {
        res.setHeader("Content-Type", metaJson.mime_type);
      }
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  };

  router.get("/api/media", handleMediaProxy);
  router.get("/api/media/:mediaId", handleMediaProxy);
  router.get("/api/media/*path", handleMediaProxy);

  return router;
}
