import { Router } from "express";
import type { Logger } from "../../../../shared/logging/logger";
import type { AnalyticsOverviewDto } from "../../analytics/domain/analytics.types";
import type { AnalyticsRepositoryPort } from "../../analytics/application/ports/analytics.repository.port";
import type { CaseRepositoryPort } from "../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../departments/application/ports/agent.repository.port";
import type { SystemSettingsService } from "../../settings/application/services/system-settings.service";
import { getStartOfDayInTimeZone } from "../application/helpers/telegram-formatting.helper";
import {
  renderExecutiveSnapshotHtml,
  renderSnapshotErrorHtml,
} from "./telegram-snapshot.renderer";

export interface TelegramSnapshotRouterDeps {
  analyticsRepo: AnalyticsRepositoryPort;
  caseRepo: CaseRepositoryPort;
  agentRepo: AgentRepositoryPort;
  settingsService: SystemSettingsService;
  logger: Logger;
  appPublicUrl?: string;
  frontendUrl?: string;
}

export function createTelegramSnapshotRouter(deps: TelegramSnapshotRouterDeps): Router {
  const router = Router();
  const { analyticsRepo, caseRepo, agentRepo, settingsService, logger } = deps;

  /**
   * GET /analitica
   * Snapshot Ejecutivo Web en tiempo real.
   * Accesible desde el botón de Telegram ("Abrir Analítica Completa") en dispositivos móviles y de escritorio.
   * Devuelve un dashboard HTML responsivo, elegante y profesional sin requerir autenticación de sesión pesada.
   */
  router.get(["/analitica", "/analitica/snapshot"], async (req, res) => {
    try {
      const settings = await settingsService.getTelegramSettings();
      const timeZone = settings.timeZone || "America/Guayaquil";
      const now = new Date();
      const startOfDay = getStartOfDayInTimeZone(timeZone, now);

      let overview: AnalyticsOverviewDto = {
        totalCases: 0,
        activeCases: 0,
        completedCases: 0,
        botContainmentRate: 0,
        avgResolutionTimeMinutes: null,
        avgQueueWaitTimeSeconds: null,
        escalationRate: 0,
        escalatedCases: 0,
      };

      try {
        overview = await analyticsRepo.getOverview({
          from: startOfDay,
          to: now,
        });
      } catch (err) {
        logger.warn({ err }, "error al consultar analyticsRepo para snapshot web");
      }

      let activeAgentsCount = 0;
      try {
        const agents = await agentRepo.list();
        activeAgentsCount = agents.filter((a) => a.active && a.autoAssignEnabled).length;
      } catch (err) {
        logger.warn({ err }, "error al consultar agentRepo para snapshot web");
      }

      let dashboard;
      try {
        dashboard = await caseRepo.getDashboardMetrics({
          actorId: "00000000-0000-0000-0000-000000000000",
          role: "admin",
          targetUserId: "00000000-0000-0000-0000-000000000000",
          departmentIds: [],
          primaryDepartmentId: null,
        });
      } catch (err) {
        logger.warn({ err }, "error al consultar getDashboardMetrics para snapshot web");
      }

      let casesDist;
      try {
        casesDist = await analyticsRepo.getCasesDistribution({
          from: startOfDay,
          to: now,
        });
      } catch (err) {
        logger.warn({ err }, "error al consultar getCasesDistribution para snapshot web");
      }

      let infraAlerts: Array<{ sector: string; oltName: string | null; activeCasesCount: number }> = [];
      try {
        const rawAlerts = await analyticsRepo.getInfrastructureAlerts({
          from: startOfDay,
          to: now,
        });
        infraAlerts = rawAlerts.map((a) => ({
          sector: a.sector,
          oltName: a.oltName,
          activeCasesCount: a.activeCasesCount,
        }));
      } catch (err) {
        logger.warn({ err }, "error al consultar getInfrastructureAlerts para snapshot web");
      }

      let unattendedCases: Array<{
        caseId: string;
        waitMinutes: number;
        customerName: string;
        departmentName: string | null;
      }> = [];
      if (typeof caseRepo.findUnattendedHumanCases === "function") {
        try {
          unattendedCases = await caseRepo.findUnattendedHumanCases(settings.slaThresholdMinutes || 15, 10);
        } catch (err) {
          logger.warn({ err }, "error al consultar findUnattendedHumanCases para snapshot web");
        }
      }

      if (req.query.format === "json" || req.headers.accept === "application/json") {
        return res.json({
          success: true,
          data: {
            timestamp: now.toISOString(),
            timeZone,
            overview,
            activeAgentsCount,
            dashboard,
            casesDist,
            infraAlerts,
            unattendedCases,
          },
        });
      }

      const html = renderExecutiveSnapshotHtml({
        overview,
        dashboard,
        casesDist,
        infraAlerts,
        unattendedCases,
        activeAgentsCount,
        timeZone,
        now,
        frontendUrl: settings.frontendUrl || deps.frontendUrl || deps.appPublicUrl || "",
      });

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.status(200).send(html);
    } catch (err) {
      logger.error({ err }, "error al generar snapshot ejecutivo web");
      return res.status(500).send(renderSnapshotErrorHtml(err instanceof Error ? err.message : String(err)));
    }
  });

  /**
   * GET /bandeja
   * Redirección o snapshot rápido de la cola operativa.
   */
  router.get("/bandeja", (_req, res) => {
    const targetUrl = deps.frontendUrl ? `${deps.frontendUrl}/bandeja` : "/analitica";
    if (deps.frontendUrl) {
      return res.redirect(targetUrl);
    }
    return res.redirect("/analitica");
  });

  return router;
}
