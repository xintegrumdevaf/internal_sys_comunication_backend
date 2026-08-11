import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../../../shared/http/require-auth";
import type { ListEscalationsUseCase } from "../application/use-cases/list-escalations.use-case";

export type EscalationsRouterDeps = {
  listEscalations: ListEscalationsUseCase;
};

/**
 * Bandeja de escalaciones + triage (03_API_CONTRACT.md §C.1).
 * Identidad via sesion real (docs/spec/06_BACKEND_GAPS.md §1.b), no header.
 */
export function createEscalationsRouter(deps: EscalationsRouterDeps): Router {
  const router = Router();

  router.get("/api/escalations", async (req, res, next) => {
    try {
      const agentUserId = requireAuth(req).id;
      const triage =
        req.query.triage === "true" ||
        req.query.departmentId === "null" ||
        req.query.departmentId === "";
      const status = z.enum(["PENDING", "ASSIGNED", "RESOLVED"]).optional().parse(req.query.status);
      const departmentId =
        triage || req.query.departmentId === undefined
          ? undefined
          : String(req.query.departmentId);

      const data = await deps.listEscalations.execute({
        agentUserId,
        triage: triage || undefined,
        departmentId: triage ? null : departmentId,
        status,
      });
      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
