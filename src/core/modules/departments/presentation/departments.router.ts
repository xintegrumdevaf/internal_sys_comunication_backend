import { Router } from "express";
import { requireAuth } from "../../../../shared/http/require-auth";
import { toPublicAgentDtoList } from "./agent-dto.mapper";
import type { ListAgentsUseCase } from "../application/use-cases/list-agents.use-case";
import type { ListDepartmentsUseCase } from "../application/use-cases/list-departments.use-case";

export type DepartmentsRouterDeps = {
  listDepartments: ListDepartmentsUseCase;
  listAgents: ListAgentsUseCase;
};

/**
 * Lecturas de catalogo (departamentos/agentes) — cualquier agente con
 * sesion real puede leerlas (docs/spec/06_BACKEND_GAPS.md §1.b); la
 * escritura vive en `admin/agents.router.ts`, restringida a role=admin.
 */
export function createDepartmentsRouter(deps: DepartmentsRouterDeps): Router {
  const router = Router();

  router.get("/api/departments", async (req, res, next) => {
    try {
      requireAuth(req);
      const departments = await deps.listDepartments.execute();
      res.json({ data: departments });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/agents", async (req, res, next) => {
    try {
      requireAuth(req);
      const agents = await deps.listAgents.execute();
      res.json({ data: toPublicAgentDtoList(agents) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
