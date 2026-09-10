import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../../../shared/http/require-auth";
import type { GetAnalyticsOverviewUseCase } from "../application/use-cases/get-analytics-overview.use-case";
import type { GetCasesDistributionUseCase } from "../application/use-cases/get-cases-distribution.use-case";
import type { GetAIEfficiencyUseCase } from "../application/use-cases/get-ai-efficiency.use-case";
import type { GetAgentsPerformanceUseCase } from "../application/use-cases/get-agents-performance.use-case";
import type { GetInfrastructureAlertsUseCase } from "../application/use-cases/get-infrastructure-alerts.use-case";

export type AnalyticsRouterDeps = {
  getOverview: GetAnalyticsOverviewUseCase;
  getCasesDistribution: GetCasesDistributionUseCase;
  getAIEfficiency: GetAIEfficiencyUseCase;
  getAgentsPerformance: GetAgentsPerformanceUseCase;
  getInfrastructureAlerts: GetInfrastructureAlertsUseCase;
};

const analyticsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  departmentId: z.string().uuid().optional(),
});

function parseFilterDates(query: unknown): { from: Date; to: Date; departmentId?: string } {
  const parsed = analyticsQuerySchema.safeParse(query);
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás por defecto

  if (!parsed.success) {
    return { from: defaultFrom, to: now };
  }

  const from = parsed.data.from ? new Date(parsed.data.from) : defaultFrom;
  const to = parsed.data.to ? new Date(parsed.data.to) : now;

  return {
    from,
    to,
    departmentId: parsed.data.departmentId,
  };
}

export function createAnalyticsRouter(deps: AnalyticsRouterDeps): Router {
  const router = Router();

  router.get("/api/analytics/overview", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const { from, to, departmentId } = parseFilterDates(req.query);

      const data = await deps.getOverview.execute({
        actor,
        from,
        to,
        departmentId,
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/analytics/cases-distribution", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const { from, to, departmentId } = parseFilterDates(req.query);

      const data = await deps.getCasesDistribution.execute({
        actor,
        from,
        to,
        departmentId,
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/analytics/ai-efficiency", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const { from, to, departmentId } = parseFilterDates(req.query);

      const data = await deps.getAIEfficiency.execute({
        actor,
        from,
        to,
        departmentId,
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/analytics/agents-performance", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const { from, to, departmentId } = parseFilterDates(req.query);

      const data = await deps.getAgentsPerformance.execute({
        actor,
        from,
        to,
        departmentId,
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/analytics/infrastructure-alerts", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const { from, to, departmentId } = parseFilterDates(req.query);

      const data = await deps.getInfrastructureAlerts.execute({
        actor,
        from,
        to,
        departmentId,
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
