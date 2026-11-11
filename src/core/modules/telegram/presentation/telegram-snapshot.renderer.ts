import type { AnalyticsOverviewDto } from "../../analytics/domain/analytics.types";
import {
  escapeTelegramHtml,
  formatWorkflowDisplayName,
} from "../application/helpers/telegram-formatting.helper";
import { buildSnapshotStyles } from "./telegram-snapshot.styles";

export interface RenderSnapshotProps {
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

export function renderExecutiveSnapshotHtml(props: RenderSnapshotProps): string {
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

  const allDepts = dashboard?.departmentBreakdown || [];
  const activeDepts = allDepts.filter((d) => d.activeCases > 0 || (d.queueCases || 0) > 0);
  const idleDepts = allDepts.filter((d) => d.activeCases === 0 && (d.queueCases || 0) === 0);
  const workflows = casesDist?.byWorkflow || [];
  const styles = buildSnapshotStyles({ isCritical, isWarning });

  return `<!DOCTYPE html>
<html lang="es" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title>Snapshot Operativo Ejecutivo • ISP Centinela</title>
  <meta name="theme-color" content="#0b0f19">
  <style>${styles}</style>
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
      <span>(${escapeTelegramHtml(timeZone)})</span>
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

  <div class="section-title">📈 Indicadores Gerenciales Clave (Hoy)</div>
  <div class="grid-2">
    <div class="card">
      <div class="card-label"><span>Casos Ingresados</span><span>📋</span></div>
      <div class="card-val">${overview.totalCases}</div>
      <div class="card-sub">${overview.completedCases} resueltos (${completionRate}%)</div>
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${completionRate}%; background: #10b981;"></div></div>
    </div>
    <div class="card">
      <div class="card-label"><span>Contención de IA</span><span>🤖</span></div>
      <div class="card-val" style="color: #38bdf8;">${containmentPct}%</div>
      <div class="card-sub">Resueltos por bot sin escalar</div>
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${containmentPct}%; background: #38bdf8;"></div></div>
    </div>
    <div class="card">
      <div class="card-label"><span>Derivación a Asesores</span><span>👤</span></div>
      <div class="card-val" style="color: #a78bfa;">${escalationPct}%</div>
      <div class="card-sub">${overview.escalatedCases || 0} derivados a humanos</div>
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${escalationPct}%; background: #a78bfa;"></div></div>
    </div>
    <div class="card">
      <div class="card-label"><span>Cumplimiento SLA</span><span>⏱️</span></div>
      <div class="card-val" style="color: ${slaBreachCount > 0 ? "var(--danger)" : "var(--success)"};">${slaBreachCount > 0 ? `${slaBreachCount} alertas` : "100%"}</div>
      <div class="card-sub">${slaBreachCount > 0 ? "Casos con espera > 15m" : "0 demoras críticas"}</div>
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${slaBreachCount > 0 ? "35" : "100"}%; background: ${slaBreachCount > 0 ? "var(--danger)" : "var(--success)"};"></div></div>
    </div>
  </div>

  <div class="section-title">⚡ Operación en Vivo en Este Instante</div>
  <div class="grid-4">
    <div class="card"><div class="card-label">En Atención</div><div class="card-val" style="color: #38bdf8;">${activeCases}</div><div class="card-sub">Asesores activos</div></div>
    <div class="card"><div class="card-label">En Cola</div><div class="card-val" style="color: ${queuePending > 0 ? "var(--danger)" : "var(--success)"};">${queuePending}</div><div class="card-sub">Esperando cupo</div></div>
    <div class="card"><div class="card-label">En Espera</div><div class="card-val">${dashboard?.waitingUser || 0}</div><div class="card-sub">Respuesta cliente</div></div>
    <div class="card"><div class="card-label">Asesores</div><div class="card-val" style="color: #34d399;">${activeAgentsCount}</div><div class="card-sub">En turno listos</div></div>
  </div>

  ${renderResponseSpeedSection(overview)}
  ${renderWorkflowsSection(workflows)}
  ${renderDepartmentsSection(activeDepts, idleDepts)}
  ${renderInfraSection(infraAlerts)}

  <div class="btn-group">
    <button onclick="window.location.reload();" class="btn btn-primary">🔄 Actualizar Snapshot en Vivo</button>
    <a href="${escapeTelegramHtml(frontendUrl || "#")}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">💻 Abrir Plataforma Web (Gestión Completa)</a>
  </div>

  <div class="footer-note">
    Este snapshot es generado automáticamente por el Centinela Operativo del ISP.<br>
    Los datos reflejan en tiempo real el estado de PostgreSQL y Redis.
  </div>
</body>
</html>`;
}

function renderResponseSpeedSection(overview: AnalyticsOverviewDto): string {
  if (overview.avgQueueWaitTimeSeconds === null && overview.avgResolutionTimeMinutes === null) {
    return "";
  }
  const waitStr = overview.avgQueueWaitTimeSeconds !== null ? `${Math.round(overview.avgQueueWaitTimeSeconds)} seg` : "Sin demoras";
  const resStr = overview.avgResolutionTimeMinutes !== null ? `${Math.round(overview.avgResolutionTimeMinutes * 10) / 10} min` : "N/D";
  return `
  <div class="section-title">⏱️ Velocidad y Tiempos Medios de Atención</div>
  <div class="grid-2">
    <div class="card"><div class="card-label">Espera Media en Cola</div><div class="card-val" style="font-size: 22px;">${waitStr}</div><div class="card-sub">Desde ingreso hasta asesor</div></div>
    <div class="card"><div class="card-label">Tiempo de Resolución</div><div class="card-val" style="font-size: 22px;">${resStr}</div><div class="card-sub">Desde apertura hasta cierre</div></div>
  </div>`;
}

function renderWorkflowsSection(workflows: Array<{ workflowType: string; count: number; percentage: number }>): string {
  if (workflows.length === 0) return "";
  const rows = workflows
    .slice(0, 5)
    .map(
      (wf) => `
      <div class="workflow-row">
        <span><b>${escapeTelegramHtml(formatWorkflowDisplayName(wf.workflowType))}</b></span>
        <span style="color: var(--text-muted);">${wf.count} casos (${Math.round(wf.percentage)}%)</span>
      </div>
      <div class="progress-bar-bg" style="margin-top: 2px; margin-bottom: 10px;">
        <div class="progress-bar-fill" style="width: ${Math.round(wf.percentage)}%; background: #0284c7;"></div>
      </div>`,
    )
    .join("");
  return `<div class="section-title">📋 Demanda por Motivo de Consulta</div><div class="card">${rows}</div>`;
}

function renderDepartmentsSection(
  activeDepts: Array<{ departmentName: string; activeCases: number; queueCases?: number }>,
  idleDepts: Array<{ departmentName: string }>,
): string {
  const listHtml =
    activeDepts.length > 0
      ? activeDepts
          .map((dept) => {
            const hasQueue = (dept.queueCases || 0) > 0;
            return `
      <div class="dept-card">
        <div>
          <div class="dept-name">${escapeTelegramHtml(dept.departmentName)}</div>
          <div class="card-sub">${dept.activeCases} casos en gestión activa</div>
        </div>
        <div class="dept-badges">
          <span class="badge badge-active">${dept.activeCases} activos</span>
          ${hasQueue ? `<span class="badge badge-queue">${dept.queueCases} en cola</span>` : `<span class="badge badge-clean">Cola libre</span>`}
        </div>
      </div>`;
          })
          .join("")
      : `<div class="card" style="text-align: center; color: var(--text-muted); font-size: 13px;">Todos los departamentos se encuentran al día y sin casos pendientes.</div>`;

  const idleNote =
    idleDepts.length > 0
      ? `<div style="font-size: 11px; color: #64748b; padding: 4px 6px; text-align: right;">+${idleDepts.length} departamentos adicionales sin colas ni casos pendientes.</div>`
      : "";

  return `<div class="section-title">🏢 Distribución Departamental</div>${listHtml}${idleNote}`;
}

function renderInfraSection(infraAlerts: Array<{ sector: string; oltName: string | null; activeCasesCount: number }>): string {
  const body =
    infraAlerts.length > 0
      ? infraAlerts
          .map(
            (alert) => `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span><b>Sector ${escapeTelegramHtml(alert.sector)}</b> (OLT: ${escapeTelegramHtml(alert.oltName || "N/D")})</span>
          <span class="badge badge-queue">${alert.activeCasesCount} reclamos</span>
        </div>`,
          )
          .join("")
      : `<div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #34d399;"><span>✓</span><span>Red y puertos OLT estables. Sin concentración anómala de reclamos hoy.</span></div>`;

  return `<div class="section-title">⚡ Monitor de Infraestructura &amp; Fibra</div><div class="card">${body}</div>`;
}

export function renderSnapshotErrorHtml(errorMsg: string): string {
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
    <p>${escapeTelegramHtml(errorMsg)}</p>
    <button onclick="window.location.reload()">Reintentar</button>
  </div>
</body>
</html>`;
}
