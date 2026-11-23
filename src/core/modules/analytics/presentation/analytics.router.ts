import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../../../shared/http/require-auth";
import type { AnalyticsCaseAttentionMode, AnalyticsExportSection } from "../domain/analytics.types";
import type { GetAnalyticsOverviewUseCase } from "../application/use-cases/get-analytics-overview.use-case";
import type { GetCasesDistributionUseCase } from "../application/use-cases/get-cases-distribution.use-case";
import type { GetAIEfficiencyUseCase } from "../application/use-cases/get-ai-efficiency.use-case";
import type { GetAgentsPerformanceUseCase } from "../application/use-cases/get-agents-performance.use-case";
import type { GetInfrastructureAlertsUseCase } from "../application/use-cases/get-infrastructure-alerts.use-case";
import type { GetDepartmentsSummaryUseCase } from "../application/use-cases/get-departments-summary.use-case";
import type { ListAnalyticsCasesUseCase } from "../application/use-cases/list-analytics-cases.use-case";
import type { ListAnalyticsCustomersUseCase } from "../application/use-cases/list-analytics-customers.use-case";
import type { GetAnalyticsExportEstimateUseCase } from "../application/use-cases/get-analytics-export-estimate.use-case";
import type { ExportAnalyticsExcelUseCase } from "../application/use-cases/export-analytics-excel.use-case";

export type AnalyticsRouterDeps = {
  getOverview: GetAnalyticsOverviewUseCase;
  getCasesDistribution: GetCasesDistributionUseCase;
  getAIEfficiency: GetAIEfficiencyUseCase;
  getAgentsPerformance: GetAgentsPerformanceUseCase;
  getInfrastructureAlerts: GetInfrastructureAlertsUseCase;
  getDepartmentsSummary?: GetDepartmentsSummaryUseCase;
  listCases?: ListAnalyticsCasesUseCase;
  listCustomers?: ListAnalyticsCustomersUseCase;
  getExportEstimate?: GetAnalyticsExportEstimateUseCase;
  exportExcel?: ExportAnalyticsExcelUseCase;
};

const analyticsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  departmentId: z.string().uuid().optional(),
});

const casesListQuerySchema = analyticsQuerySchema.extend({
  agentId: z.string().uuid().optional(),
  status: z.string().min(1).max(40).optional(),
  attentionMode: z.enum(["AI_ONLY", "AI_AND_HUMAN", "HUMAN_DIRECT"]).optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const customersListQuerySchema = analyticsQuerySchema.extend({
  agentId: z.string().uuid().optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const exportQuerySchema = analyticsQuerySchema.extend({
  agentId: z.string().uuid().optional(),
  sections: z.string().optional(),
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

function parseSectionsParam(raw?: string): AnalyticsExportSection[] {
  if (!raw || !raw.trim()) {
    return ["summary", "agents"];
  }
  const allowed = new Set<AnalyticsExportSection>(["summary", "agents", "cases", "customers"]);
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AnalyticsExportSection => allowed.has(s as AnalyticsExportSection));
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

  if (deps.getDepartmentsSummary) {
    const getDepartmentsSummary = deps.getDepartmentsSummary;
    router.get("/api/analytics/departments-summary", async (req, res, next) => {
      try {
        const actor = requireRole(req, ["manager", "admin"]);
        const { from, to, departmentId } = parseFilterDates(req.query);

        const data = await getDepartmentsSummary.execute({
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
  }

  if (deps.listCases) {
    const listCases = deps.listCases;
    router.get("/api/analytics/cases", async (req, res, next) => {
      try {
        const actor = requireRole(req, ["manager", "admin"]);
        const base = parseFilterDates(req.query);
        const parsed = casesListQuerySchema.safeParse(req.query);
        const extra = parsed.success ? parsed.data : {};

        const data = await listCases.execute({
          actor,
          from: base.from,
          to: base.to,
          departmentId: base.departmentId,
          agentId: extra.agentId,
          status: extra.status,
          attentionMode: extra.attentionMode as AnalyticsCaseAttentionMode | undefined,
          search: extra.search,
          page: extra.page,
          pageSize: extra.pageSize,
        });

        res.json({ data });
      } catch (error) {
        next(error);
      }
    });
  }

  if (deps.listCustomers) {
    const listCustomers = deps.listCustomers;
    router.get("/api/analytics/customers", async (req, res, next) => {
      try {
        const actor = requireRole(req, ["manager", "admin"]);
        const base = parseFilterDates(req.query);
        const parsed = customersListQuerySchema.safeParse(req.query);
        const extra = parsed.success ? parsed.data : {};

        const data = await listCustomers.execute({
          actor,
          from: base.from,
          to: base.to,
          departmentId: base.departmentId,
          agentId: extra.agentId,
          search: extra.search,
          page: extra.page,
          pageSize: extra.pageSize,
        });

        res.json({ data });
      } catch (error) {
        next(error);
      }
    });
  }

  if (deps.getExportEstimate) {
    const getExportEstimate = deps.getExportEstimate;
    router.get("/api/analytics/export/estimate", async (req, res, next) => {
      try {
        const actor = requireRole(req, ["manager", "admin"]);
        const base = parseFilterDates(req.query);
        const parsed = exportQuerySchema.safeParse(req.query);
        const agentId = parsed.success ? parsed.data.agentId : undefined;

        const data = await getExportEstimate.execute({
          actor,
          from: base.from,
          to: base.to,
          departmentId: base.departmentId,
          agentId,
        });

        res.json({ data });
      } catch (error) {
        next(error);
      }
    });
  }

  if (deps.exportExcel) {
    const exportExcel = deps.exportExcel;
    router.get("/api/analytics/export/excel", async (req, res, next) => {
      try {
        const actor = requireRole(req, ["manager", "admin"]);
        const base = parseFilterDates(req.query);
        const parsed = exportQuerySchema.safeParse(req.query);
        const extra = parsed.success ? parsed.data : {};
        const sections = parseSectionsParam(extra.sections);

        const prepared = await exportExcel.prepare({
          actor,
          from: base.from,
          to: base.to,
          departmentId: base.departmentId,
          agentId: extra.agentId,
          sections,
        });

        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${prepared.filename}"`,
        );
        res.setHeader("Cache-Control", "no-store");

        await exportExcel.writeToStream({
          stream: res,
          from: base.from,
          to: base.to,
          departmentIds: prepared.departmentIds,
          agentId: extra.agentId,
          areaLabel: prepared.areaLabel,
          sections: prepared.sections,
        });
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}
