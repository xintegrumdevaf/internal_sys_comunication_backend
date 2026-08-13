import { Router } from "express";
import { z } from "zod";
import { validationError } from "../../../../../shared/errors/domain-errors";
import { requireRole } from "../../../../../shared/http/require-auth";
import { toPublicAgentDto } from "../agent-dto.mapper";
import type { CreateAgentUseCase } from "../../application/use-cases/create-agent.use-case";
import type { UpdateAgentUseCase } from "../../application/use-cases/update-agent.use-case";
import type { DeactivateAgentUseCase } from "../../application/use-cases/deactivate-agent.use-case";
import type { ResetAgentPasswordUseCase } from "../../application/use-cases/reset-agent-password.use-case";

export type AgentsAdminRouterDeps = {
  createAgent: CreateAgentUseCase;
  updateAgent: UpdateAgentUseCase;
  deactivateAgent: DeactivateAgentUseCase;
  resetAgentPassword: ResetAgentPasswordUseCase;
};

const roleSchema = z.enum(["agent", "manager", "admin"]);

const createBodySchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  role: roleSchema.optional(),
  primaryDepartmentId: z.string().uuid().nullable().optional(),
  autoAssignEnabled: z.boolean().optional(),
});

const updateBodySchema = z.object({
  name: z.string().trim().min(2).optional(),
  email: z.string().trim().email().optional(),
  role: roleSchema.optional(),
  primaryDepartmentId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
  autoAssignEnabled: z.boolean().optional(),
});

/**
 * docs/spec/06_BACKEND_GAPS.md §1 — CRUD de agentes (crear/editar/desactivar/
 * restablecer contrasena), restringido a `role=admin` (docs/spec/01_DATA_MODEL.md
 * §7). La identidad viene de `req.agent` (sesion real via cookie — ver
 * session.middleware.ts), no de un header declarado por el cliente.
 * `GET /api/agents` (lectura) sigue viviendo en `departments.router.ts`.
 */
export function createAgentsAdminRouter(deps: AgentsAdminRouterDeps): Router {
  const router = Router();

  router.post("/api/agents", async (req, res, next) => {
    try {
      const admin = requireRole(req, ["admin"]);
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }
      const { agent, temporaryPassword } = await deps.createAgent.execute({
        ...parsed.data,
        actorId: admin.id,
      });
      res.status(201).json({ data: { agent: toPublicAgentDto(agent), temporaryPassword } });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/agents/:id", async (req, res, next) => {
    try {
      const admin = requireRole(req, ["admin"]);
      const parsed = updateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }
      const agent = await deps.updateAgent.execute({
        agentId: req.params.id!,
        patch: parsed.data,
        actorId: admin.id,
      });
      res.json({ data: toPublicAgentDto(agent) });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/agents/:id", async (req, res, next) => {
    try {
      const admin = requireRole(req, ["admin"]);
      const agent = await deps.deactivateAgent.execute({ agentId: req.params.id!, actorId: admin.id });
      res.json({ data: toPublicAgentDto(agent) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/agents/:id/reset-password", async (req, res, next) => {
    try {
      const admin = requireRole(req, ["admin"]);
      const { agent, temporaryPassword } = await deps.resetAgentPassword.execute({
        agentId: req.params.id!,
        actorId: admin.id,
      });
      res.json({ data: { agent: toPublicAgentDto(agent), temporaryPassword } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
