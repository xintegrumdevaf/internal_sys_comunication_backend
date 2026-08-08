import { Router } from "express";
import type { ListAgentsUseCase } from "../application/use-cases/list-agents.use-case";
import type { ListDepartmentsUseCase } from "../application/use-cases/list-departments.use-case";

export type DepartmentsRouterDeps = {
  listDepartments: ListDepartmentsUseCase;
  listAgents: ListAgentsUseCase;
};

export function createDepartmentsRouter(deps: DepartmentsRouterDeps): Router {
  const router = Router();

  router.get("/api/departments", async (_req, res, next) => {
    try {
      const departments = await deps.listDepartments.execute();
      res.json({ data: departments });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/agents", async (_req, res, next) => {
    try {
      const agents = await deps.listAgents.execute();
      res.json({ data: agents });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
