import { Router } from "express";
import { z } from "zod";
import { validationError } from "../../../../../shared/errors/domain-errors";
import { requireRole } from "../../../../../shared/http/require-auth";
import type { ListN8nWorkflowsUseCase } from "../../application/use-cases/list-n8n-workflows.use-case";
import type { UpsertN8nWorkflowUseCase } from "../../application/use-cases/upsert-n8n-workflow.use-case";
import type { DeactivateN8nWorkflowUseCase } from "../../application/use-cases/deactivate-n8n-workflow.use-case";

export type N8nWorkflowsRouterDeps = {
  listN8nWorkflows: ListN8nWorkflowsUseCase;
  upsertN8nWorkflow: UpsertN8nWorkflowUseCase;
  deactivateN8nWorkflow: DeactivateN8nWorkflowUseCase;
};

const categoryQuerySchema = z.enum(["case_action", "admin_action"]).optional();

const upsertBodySchema = z.object({
  url: z.string().url(),
  timeoutMs: z.coerce.number().int().positive().optional(),
  maxRetries: z.coerce.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});

/**
 * docs/spec/03_API_CONTRACT.md §C.1/§C.2 — catalogo de acciones de n8n,
 * editable sin redeploy, restringido a `role=admin` (docs/spec/01_DATA_MODEL.md §7).
 *
 * La identidad viene de `req.agent` (sesion real via cookie httpOnly —
 * docs/spec/06_BACKEND_GAPS.md §1.b, session.middleware.ts), ya no del
 * header `x-agent-id` declarado por el cliente sin verificacion.
 */
export function createN8nWorkflowsRouter(deps: N8nWorkflowsRouterDeps): Router {
  const router = Router();

  router.get("/api/admin/n8n-workflows", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      const category = categoryQuerySchema.parse(req.query.category);
      const entries = await deps.listN8nWorkflows.execute(category ? { category } : undefined);
      res.json({ data: entries });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/admin/n8n-workflows/:action", async (req, res, next) => {
    try {
      const admin = requireRole(req, ["admin"]);
      const parsed = upsertBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }

      const entry = await deps.upsertN8nWorkflow.execute({
        action: req.params.action,
        url: parsed.data.url,
        timeoutMs: parsed.data.timeoutMs,
        maxRetries: parsed.data.maxRetries,
        active: parsed.data.active,
        updatedBy: admin.id,
      });
      res.json({ data: entry });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/admin/n8n-workflows/:action", async (req, res, next) => {
    try {
      const admin = requireRole(req, ["admin"]);
      const entry = await deps.deactivateN8nWorkflow.execute({ action: req.params.action, updatedBy: admin.id });
      res.json({ data: entry });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
