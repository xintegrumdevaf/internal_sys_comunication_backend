import { Router } from "express";
import { requireRole } from "../../../../shared/http/require-auth";
import type { AuditRepositoryPort } from "../application/ports/audit.repository.port";

/** docs/spec/06_BACKEND_GAPS.md §1.b — registro de auditoria, solo role=admin. */
export function createAuditRouter(auditRepo: AuditRepositoryPort): Router {
  const router = Router();

  router.get("/api/audit", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const events = await auditRepo.list(limit);
      res.json({ data: events });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
