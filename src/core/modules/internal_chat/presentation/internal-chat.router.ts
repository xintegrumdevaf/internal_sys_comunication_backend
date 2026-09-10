import { Router } from "express";
import { requireAuth } from "../../../../shared/http/require-auth";
import type { GetOrCreateDirectThreadUseCase } from "../application/use-cases/get-or-create-direct-thread.use-case";
import type { ListThreadsUseCase } from "../application/use-cases/list-threads.use-case";
import type { ListMessagesUseCase } from "../application/use-cases/list-messages.use-case";
import type { SendInternalMessageUseCase } from "../application/use-cases/send-internal-message.use-case";
import type { MarkThreadAsReadUseCase } from "../application/use-cases/mark-thread-as-read.use-case";
import {
  createDirectThreadSchema,
  listMessagesQuerySchema,
  sendInternalMessageSchema,
} from "./internal-chat.schema";

export interface InternalChatRouterDeps {
  getOrCreateDirectThread: GetOrCreateDirectThreadUseCase;
  listThreads: ListThreadsUseCase;
  listMessages: ListMessagesUseCase;
  sendInternalMessage: SendInternalMessageUseCase;
  markThreadAsRead: MarkThreadAsReadUseCase;
}

export function createInternalChatRouter(deps: InternalChatRouterDeps): Router {
  const router = Router();
  const {
    getOrCreateDirectThread,
    listThreads,
    listMessages,
    sendInternalMessage,
    markThreadAsRead,
  } = deps;

  // GET /api/internal/threads - Listar hilos del agente
  router.get("/api/internal/threads", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const threads = await listThreads.execute(agent);
      res.json({ data: threads });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/internal/threads/direct - Obtener o crear hilo 1:1
  router.post("/api/internal/threads/direct", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const body = createDirectThreadSchema.parse(req.body);
      const thread = await getOrCreateDirectThread.execute({
        currentAgent: agent,
        peerAgentId: body.peerAgentId,
        referenceId: body.referenceId,
      });
      res.status(200).json({ data: thread });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/internal/threads/:id/messages - Listar mensajes de un hilo
  router.get("/api/internal/threads/:id/messages", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const threadId = req.params.id as string;
      const query = listMessagesQuerySchema.parse(req.query);
      const result = await listMessages.execute({
        currentAgent: agent,
        threadId,
        options: {
          limit: query.limit,
          cursor: query.cursor,
        },
      });
      res.json({
        data: result.messages,
        pagination: { nextCursor: result.nextCursor },
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/internal/threads/:id/messages - Enviar mensaje a un hilo
  router.post("/api/internal/threads/:id/messages", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const threadId = req.params.id as string;
      const body = sendInternalMessageSchema.parse(req.body);
      const message = await sendInternalMessage.execute({
        currentAgent: agent,
        threadId,
        body: body.body,
        type: body.type,
        contextData: body.contextData,
      });
      res.status(201).json({ data: message });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/internal/threads/:id/read - Marcar hilo como leído
  router.post("/api/internal/threads/:id/read", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const threadId = req.params.id as string;
      await markThreadAsRead.execute({
        currentAgent: agent,
        threadId,
      });
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
