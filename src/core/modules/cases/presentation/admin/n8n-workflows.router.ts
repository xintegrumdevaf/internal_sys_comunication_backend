import { Router, type Request } from "express";
import { z } from "zod";
import { authorizationError, validationError } from "../../../../../shared/errors/domain-errors";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { ListN8nWorkflowsUseCase } from "../../application/use-cases/list-n8n-workflows.use-case";
import type { UpsertN8nWorkflowUseCase } from "../../application/use-cases/upsert-n8n-workflow.use-case";
import type { DeactivateN8nWorkflowUseCase } from "../../application/use-cases/deactivate-n8n-workflow.use-case";

export type N8nWorkflowsRouterDeps = {
  agentRepo: AgentRepositoryPort;
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
 * Todavia no existe un sistema de sesiones/JWT en el proyecto (ninguna etapa
 * anterior lo construyo); mientras tanto la identidad de quien llama se
 * declara explicitamente por header `x-agent-id` y se valida su `role` en
 * cada request contra la tabla `agent` — mismo nivel de confianza que
 * `agentUserId` en el body de `POST /api/conversations/:id/reply` (Etapa 1),
 * nunca se infiere de forma implicita ni se confia en el cliente sin verificar.
 */
export function createN8nWorkflowsRouter(deps: N8nWorkflowsRouterDeps): Router {
  const router = Router();

  async function requireAdmin(req: Request): Promise<string> {
    const agentId = req.header("x-agent-id");
    if (!agentId) {
      throw validationError("Header x-agent-id requerido para administrar el catalogo de n8n");
    }
    const agent = await deps.agentRepo.findById(agentId);
    if (!agent || !agent.active || agent.role !== "admin") {
      throw authorizationError("Se requiere rol admin para administrar el catalogo de n8n");
    }
    return agent.id;
  }

  router.get("/api/admin/n8n-workflows", async (req, res, next) => {
    try {
      await requireAdmin(req);
      const category = categoryQuerySchema.parse(req.query.category);
      const entries = await deps.listN8nWorkflows.execute(category ? { category } : undefined);
      res.json({ data: entries });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/admin/n8n-workflows/:action", async (req, res, next) => {
    try {
      const adminId = await requireAdmin(req);
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
        updatedBy: adminId,
      });
      res.json({ data: entry });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/admin/n8n-workflows/:action", async (req, res, next) => {
    try {
      const adminId = await requireAdmin(req);
      const entry = await deps.deactivateN8nWorkflow.execute({ action: req.params.action, updatedBy: adminId });
      res.json({ data: entry });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
