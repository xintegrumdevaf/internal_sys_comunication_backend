import { Router } from "express";
import type { Logger } from "../../../../shared/logging/logger";
import type { AnalyticsOverviewDto } from "../../analytics/domain/analytics.types";
import type { AnalyticsRepositoryPort } from "../../analytics/application/ports/analytics.repository.port";
import type { CaseRepositoryPort } from "../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../departments/application/ports/agent.repository.port";
import type { SystemSettingsService } from "../../settings/application/services/system-settings.service";
import {
  formatWorkflowDisplayName,
  getStartOfDayInTimeZone,
} from "../application/helpers/telegram-formatting.helper";

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
      const startOfDay = getStartOfDayInTimeZone(timeZone);

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

      let unattendedCases: Array<{ caseId: string; waitMinutes: number; customerName: string; departmentName: string | null }> = [];
      if (typeof caseRepo.findUnattendedHumanCases === "function") {
        try {
          unattendedCases = await caseRepo.findUnattendedHumanCases(settings.slaThresholdMinutes || 15, 10);
        } catch (err) {
          logger.warn({ err }, "error al consultar findUnattendedHumanCases para snapshot web");
        }
      }

      // Si solicitan JSON expresamente
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
      return res.status(500).send(renderErrorHtml(err instanceof Error ? err.message : String(err)));
    }
  });

  /**
   * GET /bandeja
   * Redirección o snapshot rápido de la cola operativa.
   */
  router.get("/bandeja", (req, res) => {
    const targetUrl = deps.frontendUrl ? `${deps.frontendUrl}/bandeja` : "/analitica";
    if (deps.frontendUrl) {
      return res.redirect(targetUrl);
    }
    return res.redirect("/analitica");
  });

  return router;
}

interface RenderSnapshotProps {
  overview: AnalyticsOverviewDto;
  dashboard?: {
    myAssignedCases?: number;
    escalatedPending?: number;
    waitingUser?: number;
    departmentBreakdown?: Array<{
      departmentId: string | null;
      departmentName: string;
      activeCases: number;
      queueCases?: number;
    }>;
  };
  casesDist?: {
    byWorkflow?: Array<{
      workflowType: string;
      count: number;
      percentage: number;
    }>;
  };
  infraAlerts?: Array<{
    sector: string;
    oltName: string | null;
    activeCasesCount: number;
  }>;
  unattendedCases?: Array<{
    caseId: string;
    waitMinutes: number;
    customerName: string;
    departmentName: string | null;
  }>;
  activeAgentsCount: number;
  timeZone: string;
  now: Date;
  frontendUrl: string;
}

function renderExecutiveSnapshotHtml(props: RenderSnapshotProps): string {
  const { overview, dashboard, casesDist, infraAlerts = [], unattendedCases = [], activeAgentsCount, timeZone, now, frontendUrl } = props;

  const dateStr = now.toLocaleDateString("es-EC", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const timeStr = now.toLocaleTimeString("es-EC", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const queuePending = dashboard?.escalatedPending || 0;
  const activeCases = dashboard?.myAssignedCases || overview.activeCases || 0;
  const slaBreachCount = unattendedCases.length;

  const isCritical = slaBreachCount > 0 || queuePending > 5;
  const isWarning = !isCritical && queuePending > 0;

  const containmentPct = Math.round(overview.botContainmentRate);
  const escalationPct = Math.round(overview.escalationRate);
  const completionRate = overview.totalCases > 0 ? Math.round((overview.completedCases / overview.totalCases) * 100) : 100;

  // Filtrado inteligente de departamentos: separar con carga vs sin carga
  const allDepts = dashboard?.departmentBreakdown || [];
  const activeDepts = allDepts.filter((d) => d.activeCases > 0 || (d.queueCases || 0) > 0);
  const idleDepts = allDepts.filter((d) => d.activeCases === 0 && (d.queueCases || 0) === 0);

  const workflows = casesDist?.byWorkflow || [];

  return `<!DOCTYPE html>
<html lang="es" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title>Snapshot Operativo Ejecutivo • ISP Centinela</title>
  <meta name="theme-color" content="#0b0f19">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.15);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      padding: 16px 12px 48px;
      line-height: 1.4;
      max-width: 680px;
      margin: 0 auto;
    }
    .header {
      padding: 16px 8px 18px;
      text-align: left;
    }
    .badge-top {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(56, 189, 248, 0.12);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.25);
      margin-bottom: 8px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      background-color: ${isCritical ? "var(--danger)" : isWarning ? "var(--warning)" : "var(--success)"};
      border-radius: 50%;
      box-shadow: 0 0 8px ${isCritical ? "var(--danger)" : isWarning ? "var(--warning)" : "var(--success)"};
    }
    h1 {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .timestamp {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .timestamp code {
      background: #1e293b;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      color: #cbd5e1;
    }
    .status-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: ${
        isCritical
          ? "rgba(239, 68, 68, 0.12)"
          : isWarning
          ? "rgba(245, 158, 11, 0.12)"
          : "rgba(16, 185, 129, 0.12)"
      };
      border: 1px solid ${
        isCritical
          ? "rgba(239, 68, 68, 0.35)"
          : isWarning
          ? "rgba(245, 158, 11, 0.35)"
          : "rgba(16, 185, 129, 0.35)"
      };
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 16px;
    }
    .status-banner span {
      font-size: 13px;
      font-weight: 700;
      color: ${isCritical ? "#f87171" : isWarning ? "#fbbf24" : "#34d399"};
    }
    .section-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #94a3b8;
      margin: 22px 4px 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .grid-4 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    @media (min-width: 480px) {
      .grid-4 {
        grid-template-columns: repeat(4, 1fr);
      }
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 14px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }
    .card-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .card-val {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #ffffff;
    }
    .card-sub {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .progress-bar-bg {
      width: 100%;
      height: 6px;
      background: #1e293b;
      border-radius: 999px;
      margin-top: 8px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      border-radius: 999px;
    }
    .dept-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .dept-name {
      font-size: 13px;
      font-weight: 600;
      color: #f1f5f9;
    }
    .dept-badges {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 6px;
    }
    .badge-active {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .badge-queue {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .badge-clean {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .workflow-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .btn-group {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 24px;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary {
      background: #0284c7;
      color: #ffffff;
      border: none;
    }
    .btn-primary:active {
      background: #0369a1;
      transform: scale(0.98);
    }
    .btn-secondary {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #334155;
    }
    .btn-secondary:active {
      background: #334155;
    }
    .footer-note {
      text-align: center;
      font-size: 11px;
      color: #64748b;
      margin-top: 24px;
    }
  </style>
</head>
<body>

  <div class="header">
    <div class="badge-top">
      <span class="pulse-dot"></span>
      Centinela ISP • Snapshot Ejecutivo
    </div>
    <h1>Panel Operativo en Vivo</h1>
    <div class="timestamp">
      <span>Corte:</span>
      <code>${dateStr}</code>
      <code>${timeStr}</code>
      <span>(${timeZone})</span>
    </div>
  </div>

  <div class="status-banner">
    <span>${
      isCritical
        ? "🔴 Atención Crítica: Brechas de SLA o Demoras en Cola"
        : isWarning
        ? "🟡 Atención Requerida: Clientes en Cola de Espera"
        : "🟢 Operación Estable y en Control"
    }</span>
    <span style="font-size: 11px; font-weight: 600; color: var(--text-muted);">${queuePending} en cola | ${slaBreachCount} SLA crítico</span>
  </div>

  <!-- SECCIÓN 1: INDICADORES GERENCIALES CLAVE (HOY) -->
  <div class="section-title">
    📈 Indicadores Gerenciales Clave (Hoy)
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-label">
        <span>Casos Ingresados</span>
        <span>📋</span>
      </div>
      <div class="card-val">${overview.totalCases}</div>
      <div class="card-sub">${overview.completedCases} resueltos (${completionRate}%)</div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: ${completionRate}%; background: #10b981;"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-label">
        <span>Contención de IA</span>
        <span>🤖</span>
      </div>
      <div class="card-val" style="color: #38bdf8;">${containmentPct}%</div>
      <div class="card-sub">Resueltos por bot sin escalar</div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: ${containmentPct}%; background: #38bdf8;"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-label">
        <span>Derivación a Asesores</span>
        <span>👤</span>
      </div>
      <div class="card-val" style="color: #a78bfa;">${escalationPct}%</div>
      <div class="card-sub">${overview.escalatedCases || 0} derivados a humanos</div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: ${escalationPct}%; background: #a78bfa;"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-label">
        <span>Cumplimiento SLA</span>
        <span>⏱️</span>
      </div>
      <div class="card-val" style="color: ${slaBreachCount > 0 ? "var(--danger)" : "var(--success)"};">
        ${slaBreachCount > 0 ? `${slaBreachCount} alertas` : "100%"}
      </div>
      <div class="card-sub">${slaBreachCount > 0 ? "Casos con espera > 15m" : "0 demoras críticas"}</div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: ${slaBreachCount > 0 ? "35" : "100"}%; background: ${slaBreachCount > 0 ? "var(--danger)" : "var(--success)"};"></div>
      </div>
    </div>
  </div>

  <!-- SECCIÓN 2: ESTADO EN VIVO AHORA MISMO -->
  <div class="section-title">
    ⚡ Operación en Vivo en Este Instante
  </div>

  <div class="grid-4">
    <div class="card">
      <div class="card-label">En Atención</div>
      <div class="card-val" style="color: #38bdf8;">${activeCases}</div>
      <div class="card-sub">Asesores activos</div>
    </div>

    <div class="card">
      <div class="card-label">En Cola</div>
      <div class="card-val" style="color: ${queuePending > 0 ? "var(--danger)" : "var(--success)"};">${queuePending}</div>
      <div class="card-sub">Esperando cupo</div>
    </div>

    <div class="card">
      <div class="card-label">En Espera</div>
      <div class="card-val">${dashboard?.waitingUser || 0}</div>
      <div class="card-sub">Respuesta cliente</div>
    </div>

    <div class="card">
      <div class="card-label">Asesores</div>
      <div class="card-val" style="color: #34d399;">${activeAgentsCount}</div>
      <div class="card-sub">En turno listos</div>
    </div>
  </div>

  <!-- SECCIÓN 3: TIEMPOS DE RESPUESTA -->
  ${
    overview.avgQueueWaitTimeSeconds !== null || overview.avgResolutionTimeMinutes !== null
      ? `
  <div class="section-title">
    ⏱️ Velocidad y Tiempos Medios de Atención
  </div>
  <div class="grid-2">
    <div class="card">
      <div class="card-label">Espera Media en Cola</div>
      <div class="card-val" style="font-size: 22px;">${
        overview.avgQueueWaitTimeSeconds !== null ? Math.round(overview.avgQueueWaitTimeSeconds) + " seg" : "Sin demoras"
      }</div>
      <div class="card-sub">Desde ingreso hasta asesor</div>
    </div>
    <div class="card">
      <div class="card-label">Tiempo de Resolución</div>
      <div class="card-val" style="font-size: 22px;">${
        overview.avgResolutionTimeMinutes !== null ? (Math.round(overview.avgResolutionTimeMinutes * 10) / 10) + " min" : "N/D"
      }</div>
      <div class="card-sub">Desde apertura hasta cierre</div>
    </div>
  </div>
  `
      : ""
  }

  <!-- SECCIÓN 4: DEMANDA POR TIPO DE RECLAMO (WORKFLOWS) -->
  ${
    workflows.length > 0
      ? `
  <div class="section-title">
    📋 Demanda por Motivo de Consulta
  </div>
  <div class="card">
    ${workflows
      .slice(0, 5)
      .map(
        (wf) => `
      <div class="workflow-row">
        <span><b>${formatWorkflowDisplayName(wf.workflowType)}</b></span>
        <span style="color: var(--text-muted);">${wf.count} casos (${Math.round(wf.percentage)}%)</span>
      </div>
      <div class="progress-bar-bg" style="margin-top: 2px; margin-bottom: 10px;">
        <div class="progress-bar-fill" style="width: ${Math.round(wf.percentage)}%; background: #0284c7;"></div>
      </div>
    `,
      )
      .join("")}
  </div>
  `
      : ""
  }

  <!-- SECCIÓN 5: CARGA POR DEPARTAMENTO -->
  <div class="section-title">
    🏢 Distribución Departamental
  </div>

  ${
    activeDepts.length > 0
      ? activeDepts
          .map((dept) => {
            const hasQueue = (dept.queueCases || 0) > 0;
            return `
      <div class="dept-card">
        <div>
          <div class="dept-name">${dept.departmentName}</div>
          <div class="card-sub">${dept.activeCases} casos en gestión activa</div>
        </div>
        <div class="dept-badges">
          <span class="badge badge-active">${dept.activeCases} activos</span>
          ${
            hasQueue
              ? `<span class="badge badge-queue">${dept.queueCases} en cola</span>`
              : `<span class="badge badge-clean">Cola libre</span>`
          }
        </div>
      </div>
      `;
          })
          .join("")
      : `
    <div class="card" style="text-align: center; color: var(--text-muted); font-size: 13px;">
      Todos los departamentos se encuentran al día y sin casos pendientes.
    </div>
    `
  }

  ${
    idleDepts.length > 0
      ? `
    <div style="font-size: 11px; color: #64748b; padding: 4px 6px; text-align: right;">
      +${idleDepts.length} departamentos adicionales sin colas ni casos pendientes.
    </div>
  `
      : ""
  }

  <!-- SECCIÓN 6: MONITOR DE RED & OLT -->
  <div class="section-title">
    ⚡ Monitor de Infraestructura & Fibra
  </div>
  <div class="card">
    ${
      infraAlerts.length > 0
        ? infraAlerts
            .map(
              (alert) => `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span><b>Sector ${alert.sector}</b> (OLT: ${alert.oltName})</span>
          <span class="badge badge-queue">${alert.activeCasesCount} reclamos</span>
        </div>
      `,
            )
            .join("")
        : `
      <div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #34d399;">
        <span>✓</span>
        <span>Red y puertos OLT estables. Sin concentración anómala de reclamos hoy.</span>
      </div>
    `
    }
  </div>

  <!-- BOTONES DE ACCIÓN RÁPIDA -->
  <div class="btn-group">
    <button onclick="window.location.reload();" class="btn btn-primary">
      🔄 Actualizar Snapshot en Vivo
    </button>
    <a href="${frontendUrl || "#"}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">
      💻 Abrir Plataforma Web (Gestión Completa)
    </a>
  </div>

  <!-- BOTONES DE ACCIÓN RÁPIDA -->
  <div class="btn-group">
    <button onclick="window.location.reload();" class="btn btn-primary">
      🔄 Actualizar Snapshot en Vivo
    </button>
    <a href="${frontendUrl || "#"}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">
      💻 Abrir Plataforma Web (Gestión Completa)
    </a>
  </div>

  <div class="footer-note">
    Este snapshot es generado automáticamente por el Centinela Operativo del ISP.<br>
    Los datos reflejan en tiempo real el estado de PostgreSQL y Redis.
  </div>

</body>
</html>`;
}

function renderErrorHtml(errorMsg: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Error • Snapshot Ejecutivo</title>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; }
    .box { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; max-width: 400px; }
    h2 { color: #ef4444; margin-top: 0; }
    p { font-size: 13px; color: #94a3b8; }
    button { background: #0284c7; color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Error al cargar analítica</h2>
    <p>${errorMsg}</p>
    <button onclick="window.location.reload()">Reintentar</button>
  </div>
</body>
</html>`;
}
