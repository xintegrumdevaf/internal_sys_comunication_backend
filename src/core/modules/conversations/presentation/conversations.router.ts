import { Router } from "express";
import { z } from "zod";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { ListConversationsUseCase } from "../application/use-cases/list-conversations.use-case";
import type { ListMessagesUseCase } from "../application/use-cases/list-messages.use-case";
import type { ReplyAsHumanUseCase } from "../application/use-cases/reply-as-human.use-case";

export type ConversationsRouterDeps = {
  listConversations: ListConversationsUseCase;
  listMessages: ListMessagesUseCase;
  replyAsHuman: ReplyAsHumanUseCase;
};

const statusSchema = z.enum(["open", "pending", "resolved", "closed"]).optional();

const replyBodySchema = z.object({
  agentUserId: z.string().min(1),
  body: z.string().min(1),
});

/**
 * docs/spec/03_API_CONTRACT.md §C.1/§C.2 — subconjunto que cubre la Etapa 1
 * (conversaciones + mensajes + respuesta humana). `departmentId`/`userId`
 * de la lista se conectan cuando exista el modulo `cases` (Etapa 2).
 */
export function createConversationsRouter(deps: ConversationsRouterDeps): Router {
  const router = Router();
  const { listConversations, listMessages, replyAsHuman } = deps;

  router.get("/api/conversations", async (req, res, next) => {
    try {
      const status = statusSchema.parse(req.query.status);
      const conversations = await listConversations.execute({ status });
      res.json({ data: conversations });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/conversations/:id/messages", async (req, res, next) => {
    try {
      const messages = await listMessages.execute(req.params.id);
      res.json({ data: messages });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/conversations/:id/reply", async (req, res, next) => {
    try {
      const parsed = replyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }

      const message = await replyAsHuman.execute({
        conversationId: req.params.id,
        agentUserId: parsed.data.agentUserId,
        body: parsed.data.body,
      });
      res.status(201).json({ data: message });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
