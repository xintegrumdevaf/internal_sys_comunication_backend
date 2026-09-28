import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../../../shared/http/require-auth";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { ListTagsUseCase } from "../application/use-cases/list-tags.use-case";
import type { CreateTagUseCase } from "../application/use-cases/create-tag.use-case";
import type { UpdateTagUseCase } from "../application/use-cases/update-tag.use-case";
import type { DeleteTagUseCase } from "../application/use-cases/delete-tag.use-case";

export interface TagsRouterDeps {
  listTags: ListTagsUseCase;
  createTag: CreateTagUseCase;
  updateTag: UpdateTagUseCase;
  deleteTag: DeleteTagUseCase;
}

const createTagSchema = z.object({
  name: z.string().trim().min(1, "El nombre de la etiqueta es requerido"),
  description: z.string().trim().optional().nullable(),
  color: z.string().trim().optional().nullable(),
});

const updateTagSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().optional().nullable(),
  color: z.string().trim().optional().nullable(),
  active: z.boolean().optional(),
});

export function createTagsRouter(deps: TagsRouterDeps): Router {
  const router = Router();

  /**
   * GET /api/tags
   * Lista el catálogo de etiquetas. Agentes autenticados pueden verlas.
   */
  router.get("/api/tags", async (req, res, next) => {
    try {
      requireAuth(req);
      const includeInactive = req.query.includeInactive === "true";
      const tags = await deps.listTags.execute(includeInactive);
      res.json({ data: tags });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/tags
   * Crea una nueva etiqueta (requiere rol admin o manager).
   */
  router.post("/api/tags", async (req, res, next) => {
    try {
      requireRole(req, ["admin", "manager"]);
      const parsed = createTagSchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      const tag = await deps.createTag.execute(parsed.data);
      res.status(201).json({ data: tag });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PATCH /api/tags/:id
   * Modifica una etiqueta (requiere rol admin o manager).
   */
  router.patch("/api/tags/:id", async (req, res, next) => {
    try {
      requireRole(req, ["admin", "manager"]);
      const parsed = updateTagSchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      const tag = await deps.updateTag.execute(req.params.id, parsed.data);
      res.json({ data: tag });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/tags/:id
   * Elimina una etiqueta del catálogo (requiere rol admin o manager).
   */
  router.delete("/api/tags/:id", async (req, res, next) => {
    try {
      requireRole(req, ["admin", "manager"]);
      await deps.deleteTag.execute(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
