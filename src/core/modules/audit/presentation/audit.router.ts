import { Router } from "express";
import type { AuditRepositoryPort } from "../application/ports/audit.repository.port";

export function createAuditRouter(auditRepo: AuditRepositoryPort): Router {
  const router = Router();

  router.get("/api/audit", async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const events = await auditRepo.list(limit);
    res.json({ data: events });
  });

  return router;
}
