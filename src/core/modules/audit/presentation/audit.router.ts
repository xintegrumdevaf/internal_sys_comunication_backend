import { Router } from "express";
import { requireAuth } from "../../../../shared/http/require-auth";
import type { ListAuditEventsUseCase } from "../application/use-cases/list-audit-events.use-case";
import type { GetAuditStatsUseCase } from "../application/use-cases/get-audit-stats.use-case";
import { auditStatsQuerySchema, listAuditQuerySchema } from "./audit.schema";

export interface AuditRouterDeps {
  listAuditEvents: ListAuditEventsUseCase;
  getAuditStats: GetAuditStatsUseCase;
}

/**
 * docs/spec/03_API_CONTRACT.md §C.1/§C.2 — Registro y consulta de auditoría empresarial.
 * Acceso: 'admin' (global) y 'manager' (alcance a sus departamentos).
 */
export function createAuditRouter(deps: AuditRouterDeps): Router {
  const router = Router();
  const { listAuditEvents, getAuditStats } = deps;

  // GET /api/audit/stats - Resumen analítico de auditoría
  router.get("/api/audit/stats", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const query = auditStatsQuerySchema.parse(req.query);

      const stats = await getAuditStats.execute({
        currentAgent: agent,
        filter: {
          departmentId: query.departmentId,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
        },
      });

      res.json({ data: stats });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/audit - Listado paginado con filtros avanzados
  router.get("/api/audit", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const query = listAuditQuerySchema.parse(req.query);

      const result = await listAuditEvents.execute({
        currentAgent: agent,
        filter: {
          action: query.action ? query.action.split(",").map((s) => s.trim()) : undefined,
          category: query.category,
          resourceType: query.resourceType,
          resourceId: query.resourceId,
          actorId: query.actorId,
          departmentId: query.departmentId,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
          search: query.search,
          limit: query.limit,
          cursor: query.cursor,
        },
      });

      res.json({
        data: result.events,
        pagination: { nextCursor: result.nextCursor },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
