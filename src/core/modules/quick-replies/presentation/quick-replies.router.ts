import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../../../shared/http/require-auth";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { CreateQuickReplyUseCase } from "../application/use-cases/create-quick-reply.use-case";
import type { UpdateQuickReplyUseCase } from "../application/use-cases/update-quick-reply.use-case";
import type { DeleteQuickReplyUseCase } from "../application/use-cases/delete-quick-reply.use-case";
import type { ListQuickRepliesUseCase } from "../application/use-cases/list-quick-replies.use-case";
import type { ResolveQuickReplyUseCase } from "../application/use-cases/resolve-quick-reply.use-case";

export interface QuickRepliesRouterDeps {
  createQuickReply: CreateQuickReplyUseCase;
  updateQuickReply: UpdateQuickReplyUseCase;
  deleteQuickReply: DeleteQuickReplyUseCase;
  listQuickReplies: ListQuickRepliesUseCase;
  resolveQuickReply: ResolveQuickReplyUseCase;
}

const createBodySchema = z.object({
  shortcut: z.string().trim().min(1, "El atajo es requerido"),
  title: z.string().trim().min(2, "El título debe tener al menos 2 caracteres"),
  body: z.string().trim().min(1, "El cuerpo del mensaje es requerido"),
  departmentId: z.string().uuid().nullable().optional(),
  category: z.string().trim().optional().nullable(),
  mediaUrl: z.string().url().optional().nullable().or(z.literal("")),
});

const updateBodySchema = z.object({
  shortcut: z.string().trim().min(1).optional(),
  title: z.string().trim().min(2).optional(),
  body: z.string().trim().min(1).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  category: z.string().trim().optional().nullable(),
  mediaUrl: z.string().url().optional().nullable().or(z.literal("")),
  active: z.boolean().optional(),
});

export function createQuickRepliesRouter(deps: QuickRepliesRouterDeps): Router {
  const router = Router();

  /**
   * GET /api/quick-replies
   * Lista respuestas rápidas disponibles para el operador autenticado.
   */
  router.get("/api/quick-replies", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const rawDept = req.query.departmentId;
      let departmentId: string | null | undefined = undefined;

      if (rawDept !== undefined) {
        departmentId = rawDept === "null" || rawDept === "" ? null : String(rawDept);
      }

      const activeOnly = req.query.activeOnly !== undefined
        ? req.query.activeOnly === "true"
        : undefined;

      const replies = await deps.listQuickReplies.execute(
        {
          departmentId,
          search: req.query.search ? String(req.query.search) : undefined,
          category: req.query.category ? String(req.query.category) : undefined,
          activeOnly,
        },
        agent,
      );

      res.json({ quickReplies: replies });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/quick-replies/resolve
   * Resuelve un atajo específico con interpolación de variables contextuales.
   */
  router.get("/api/quick-replies/resolve", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const shortcut = req.query.shortcut ? String(req.query.shortcut) : "";
      if (!shortcut) {
        throw validationError("El parámetro de consulta 'shortcut' es requerido");
      }

      const rawDept = req.query.departmentId;
      const departmentId = rawDept !== undefined && rawDept !== "null" && rawDept !== ""
        ? String(rawDept)
        : null;

      const conversationId = req.query.conversationId
        ? String(req.query.conversationId)
        : undefined;

      const result = await deps.resolveQuickReply.execute({
        shortcut,
        departmentId,
        conversationId,
        actor: agent,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/quick-replies
   * Crea una nueva respuesta rápida. Restringido a Admin y Manager.
   */
  router.post("/api/quick-replies", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["admin", "manager"]);
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }

      const created = await deps.createQuickReply.execute(
        {
          shortcut: parsed.data.shortcut,
          title: parsed.data.title,
          body: parsed.data.body,
          departmentId: parsed.data.departmentId ?? null,
          category: parsed.data.category ?? null,
          mediaUrl: parsed.data.mediaUrl ? parsed.data.mediaUrl : null,
        },
        actor,
      );

      res.status(201).json({ quickReply: created });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/quick-replies/:id
   * Actualiza una respuesta rápida existente. Restringido a Admin y Manager.
   */
  router.put("/api/quick-replies/:id", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["admin", "manager"]);
      const { id } = req.params;
      if (!id) {
        throw validationError("El ID de la respuesta rápida es requerido");
      }

      const parsed = updateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }

      const updated = await deps.updateQuickReply.execute(
        id,
        {
          shortcut: parsed.data.shortcut,
          title: parsed.data.title,
          body: parsed.data.body,
          departmentId: parsed.data.departmentId,
          category: parsed.data.category,
          mediaUrl: parsed.data.mediaUrl !== undefined
            ? (parsed.data.mediaUrl ? parsed.data.mediaUrl : null)
            : undefined,
          active: parsed.data.active,
        },
        actor,
      );

      res.json({ quickReply: updated });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/quick-replies/:id
   * Elimina una respuesta rápida. Restringido a Admin y Manager.
   */
  router.delete("/api/quick-replies/:id", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["admin", "manager"]);
      const { id } = req.params;
      if (!id) {
        throw validationError("El ID de la respuesta rápida es requerido");
      }

      await deps.deleteQuickReply.execute(id, actor);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
