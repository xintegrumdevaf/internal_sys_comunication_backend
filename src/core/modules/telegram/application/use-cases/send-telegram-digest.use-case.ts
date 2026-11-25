import { businessError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AnalyticsRepositoryPort } from "../../../analytics/application/ports/analytics.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { SendTelegramAlertUseCase } from "./send-telegram-alert.use-case";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import {
  DEFAULT_TELEGRAM_DRIVE_MONITOR,
  computeDriveFileStaleness,
  formatDriveTimestamp,
  formatElapsedHoursLabel,
} from "../../domain/drive-file-sync.entity";
import type { DriveFileSyncStorePort } from "../ports/drive-file-sync.store.port";
import type { TelegramMessageResult } from "../../domain/telegram-message.types";
import {
  escapeTelegramHtml,
  formatWorkflowDisplayName,
  getStartOfDayInTimeZone,
} from "../helpers/telegram-formatting.helper";

export interface SendTelegramDigestDeps {
  analyticsRepo: AnalyticsRepositoryPort;
  caseRepo: CaseRepositoryPort;
  agentRepo: AgentRepositoryPort;
  sendTelegramAlert: SendTelegramAlertUseCase;
  getSettings: () => Promise<TelegramSettings>;
  appPublicUrl: string;
  logger: Logger;
  driveFileSyncStore?: DriveFileSyncStorePort;
}

export interface SendTelegramDigestInput {
  forced?: boolean;
  timeLabel?: string;
  chatId?: string;
  botToken?: string;
}

export class SendTelegramDigestUseCase {
  constructor(private readonly deps: SendTelegramDigestDeps) {}

  async execute(input: SendTelegramDigestInput = {}): Promise<TelegramMessageResult | null> {
    const settings = await this.deps.getSettings();
    const targetChatId = (input.chatId || settings.defaultChatId || "").trim();

    if (!targetChatId) {
      if (input.forced) {
        throw businessError("No se puede emitir el pulso ejecutivo: Chat ID de Telegram no configurado. Por favor detectá tu grupo o ingresá el Chat ID antes de enviar una prueba.");
      }
      return null;
    }

    if (!input.forced && (!settings.enabled || !settings.digestsEnabled)) {
      this.deps.logger.debug("digests de Telegram deshabilitados; omitiendo envío automático");
      return null;
    }

    const timeZone = settings.timeZone || "America/Guayaquil";
    const now = new Date();
    const startOfDay = getStartOfDayInTimeZone(timeZone);

    // 1. Obtener métricas acumuladas del día
    let overview;
    try {
      overview = await this.deps.analyticsRepo.getOverview({
        from: startOfDay,
        to: now,
      });
    } catch (err) {
      this.deps.logger.warn({ err }, "error al consultar analyticsRepo.getOverview para digest");
      overview = {
        totalCases: 0,
        activeCases: 0,
        completedCases: 0,
        botContainmentRate: 0,
        avgResolutionTimeMinutes: null,
        avgQueueWaitTimeSeconds: null,
        escalationRate: 0,
      };
    }

    // 2. Obtener estado en vivo de departamentos y agentes
    let activeAgentsCount = 0;
    try {
      const agents = await this.deps.agentRepo.list();
      activeAgentsCount = agents.filter((a) => a.active && a.autoAssignEnabled).length;
    } catch (err) {
      this.deps.logger.warn({ err }, "error al consultar agentRepo para digest");
    }

    // 3. Obtener breakdown del dashboard directivo
    let dashboard;
    try {
      dashboard = await this.deps.caseRepo.getDashboardMetrics({
        actorId: "00000000-0000-0000-0000-000000000000",
        role: "admin",
        targetUserId: "00000000-0000-0000-0000-000000000000",
        departmentIds: [],
        primaryDepartmentId: null,
      });
    } catch (err) {
      this.deps.logger.warn({ err }, "error al consultar getDashboardMetrics para digest");
    }

    // 4. Obtener distribución de demanda por workflows
    let casesDist;
    try {
      casesDist = await this.deps.analyticsRepo.getCasesDistribution({
        from: startOfDay,
        to: now,
      });
    } catch (err) {
      this.deps.logger.warn({ err }, "error al consultar getCasesDistribution para digest");
    }

    // 5. Obtener alertas de concentración de infraestructura / OLT
    let infraAlerts: Array<{ sector: string; oltName: string | null; activeCasesCount: number }> = [];
    try {
      const rawAlerts = await this.deps.analyticsRepo.getInfrastructureAlerts({
        from: startOfDay,
        to: now,
      });
      infraAlerts = rawAlerts.map((a) => ({
        sector: a.sector,
        oltName: a.oltName,
        activeCasesCount: a.activeCasesCount,
      }));
    } catch (err) {
      this.deps.logger.warn({ err }, "error al consultar getInfrastructureAlerts para digest");
    }

    // 6. Obtener casos con SLA crítico excedido
    let unattendedCases: Array<{ caseId: string; waitMinutes: number; customerName: string; departmentName: string | null }> = [];
    if (typeof this.deps.caseRepo.findUnattendedHumanCases === "function") {
      try {
        unattendedCases = await this.deps.caseRepo.findUnattendedHumanCases(settings.slaThresholdMinutes || 15, 5);
      } catch (err) {
        this.deps.logger.warn({ err }, "error al consultar findUnattendedHumanCases para digest");
      }
    }

    // 7. Formatear reporte ejecutivo en Telegram HTML
    const timeFormatted = now.toLocaleTimeString("es-EC", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const dateFormatted = now.toLocaleDateString("es-EC", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    const labelHeader = input.timeLabel ? ` - ${input.timeLabel}` : "";

    const queuePending = dashboard?.escalatedPending || 0;
    const activeCases = dashboard?.myAssignedCases || overview.activeCases || 0;
    const criticalSla = unattendedCases.length > 0;
    const isHeavyLoad = queuePending > 3;

    let healthStatus = "🟢 <i>Operación Normal y Fluida</i>";
    if (criticalSla) {
      healthStatus = `🔴 <b>Atención Crítica (${unattendedCases.length} caso(s) en SLA excedido)</b>`;
    } else if (isHeavyLoad) {
      healthStatus = `🟡 <b>Atención Requerida (${queuePending} en cola de espera)</b>`;
    }

    const lines: string[] = [
      `📊 <b>PULSO OPERATIVO EJECUTIVO${labelHeader}</b>`,
      `📅 <code>${dateFormatted}</code> • 🕒 <code>${timeFormatted}</code>`,
      `Estado: ${healthStatus}`,
      "",
      "━━━━━━━━━━━━━━━━━━━━━━",
      "📈 <b>MÉTRICAS DE HOY</b>",
      "━━━━━━━━━━━━━━━━━━━━━━",
      `• <b>Casos Registrados:</b> <b>${overview.totalCases}</b>`,
      `• <b>Casos Resueltos:</b> <b>${overview.completedCases}</b>`,
      `• <b>Contención de IA:</b> <b>${Math.round(overview.botContainmentRate)}%</b> 🤖`,
      `• <b>Derivación Humana:</b> <b>${Math.round(overview.escalationRate)}%</b> 👤`,
    ];

    if (overview.avgQueueWaitTimeSeconds !== null || overview.avgResolutionTimeMinutes !== null) {
      lines.push("");
      lines.push("⏱️ <b>TIEMPOS DE ATENCIÓN</b>");
      if (overview.avgQueueWaitTimeSeconds !== null) {
        const waitSec = Math.round(overview.avgQueueWaitTimeSeconds);
        lines.push(`• <b>Espera media en cola:</b> <b>${waitSec} seg</b>`);
      }
      if (overview.avgResolutionTimeMinutes !== null) {
        const resMin = Math.round(overview.avgResolutionTimeMinutes * 10) / 10;
        lines.push(`• <b>Tiempo medio de resolución:</b> <b>${resMin} min</b>`);
      }
    }

    if (unattendedCases.length > 0) {
      lines.push("");
      lines.push("━━━━━━━━━━━━━━━━━━━━━━");
      lines.push(`🚨 <b>ALERTAS CRÍTICAS DE SLA (&gt; ${settings.slaThresholdMinutes || 15} min)</b>`);
      lines.push("━━━━━━━━━━━━━━━━━━━━━━");
      lines.push(`• <b>${unattendedCases.length} caso(s) excediendo tiempo máximo de espera:</b>`);
      for (const c of unattendedCases.slice(0, 3)) {
        const dept = c.departmentName ? `${escapeTelegramHtml(c.departmentName)}: ` : "";
        const client = c.customerName ? escapeTelegramHtml(c.customerName) : "Cliente";
        lines.push(`  ⚠️ ${dept}${client} (<b>${Math.round(c.waitMinutes)}m</b> en espera)`);
      }
    }

    if (dashboard) {
      lines.push("");
      lines.push("━━━━━━━━━━━━━━━━━━━━━━");
      lines.push("👥 <b>OPERACIÓN EN TIEMPO REAL</b>");
      lines.push("━━━━━━━━━━━━━━━━━━━━━━");
      lines.push(`• <b>En atención humana activa:</b> <b>${activeCases}</b>`);
      lines.push(`• <b>En cola de espera:</b> <b>${queuePending}</b> ${queuePending > 0 ? "⚠️" : "✓"}`);
      lines.push(`• <b>Casos en seguimiento (En Espera):</b> <b>${dashboard.waitingUser || 0}</b>`);
      lines.push(`• <b>Asesores en turno disponibles:</b> <b>${activeAgentsCount}</b>`);

      if (dashboard.departmentBreakdown && dashboard.departmentBreakdown.length > 0) {
        lines.push("");
        lines.push("🏢 <b>CARGA POR DEPARTAMENTO</b>");
        const activeDepts = dashboard.departmentBreakdown.filter(
          (d) => d.activeCases > 0 || (d.queueCases !== undefined && d.queueCases > 0),
        );
        const idleDeptsCount = dashboard.departmentBreakdown.length - activeDepts.length;

        if (activeDepts.length > 0) {
          for (const dept of activeDepts) {
            const queuePart = dept.queueCases !== undefined ? ` | ${dept.queueCases} en cola` : "";
            lines.push(`• <b>${escapeTelegramHtml(dept.departmentName)}:</b> <b>${dept.activeCases} activos${queuePart}</b>`);
          }
          if (idleDeptsCount > 0) {
            lines.push(`• <i>Otros departamentos sin carga (${idleDeptsCount}):</i> 0 activos | cola libre`);
          }
        } else {
          lines.push(`• <i>Todos los departamentos (${idleDeptsCount}) con cola libre y sin carga activa</i>`);
        }
      }
    }

    if (casesDist?.byWorkflow && casesDist.byWorkflow.length > 0) {
      const topWorkflows = casesDist.byWorkflow.filter((w) => w.count > 0).slice(0, 4);
      if (topWorkflows.length > 0) {
        lines.push("");
        lines.push("━━━━━━━━━━━━━━━━━━━━━━");
        lines.push("🏷️ <b>DEMANDA POR TIPO DE GESTIÓN</b>");
        lines.push("━━━━━━━━━━━━━━━━━━━━━━");
        for (const w of topWorkflows) {
          lines.push(`• <b>${escapeTelegramHtml(formatWorkflowDisplayName(w.workflowType))}:</b> <b>${w.count}</b> (${w.percentage}%)`);
        }
      }
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("🌐 <b>MONITOR DE INFRAESTRUCTURA</b>");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━");
    if (infraAlerts.length > 0) {
      lines.push(`• ⚠️ <b>${infraAlerts.length} alerta(s) de concentración OLT / Sector detectadas:</b>`);
      for (const a of infraAlerts.slice(0, 3)) {
        lines.push(`  - <b>${escapeTelegramHtml(a.oltName || a.sector)}:</b> ${a.activeCasesCount} casos concurrentes`);
      }
    } else {
      lines.push("• <b>Red OLT / Fibra Óptica:</b> 🟢 Sin incidentes masivos reportados");
    }

    const driveSettings = settings.driveMonitor ?? DEFAULT_TELEGRAM_DRIVE_MONITOR;
    if (driveSettings.enabled && this.deps.driveFileSyncStore) {
      try {
        const syncState = await this.deps.driveFileSyncStore.getState();
        const enabledFiles = driveSettings.files.filter((f) => f.enabled);
        if (enabledFiles.length > 0) {
          lines.push("");
          lines.push("━━━━━━━━━━━━━━━━━━━━━━");
          lines.push("📁 <b>ARCHIVOS EN GOOGLE DRIVE</b>");
          lines.push("━━━━━━━━━━━━━━━━━━━━━━");
          for (const fileCfg of enabledFiles) {
            const record = syncState.records[fileCfg.key];
            if (!record?.lastModifiedTime) {
              lines.push(
                `• <b>${escapeTelegramHtml(fileCfg.expectedFileName)}:</b> ⚪ Sin reporte de n8n aún`,
              );
              continue;
            }
            const thresholdHours =
              fileCfg.staleThresholdHours ?? driveSettings.staleThresholdHours ?? 24;
            const { elapsedHours, isStale } = computeDriveFileStaleness(
              record.lastModifiedTime,
              thresholdHours,
            );
            const icon = isStale ? "⚠️" : "🟢";
            const ageText =
              elapsedHours !== null ? formatElapsedHoursLabel(elapsedHours) : "N/D";
            const modifiedFormatted = formatDriveTimestamp(record.lastModifiedTime, timeZone);
            const editor = record.lastModifiedBy || record.lastModifiedByEmail || "N/D";
            lines.push(
              `• ${icon} <b>${escapeTelegramHtml(record.fileName)}:</b> <code>${escapeTelegramHtml(modifiedFormatted)}</code> (hace ${ageText}, por ${escapeTelegramHtml(editor)})`,
            );
          }
        }
      } catch (err) {
        this.deps.logger.warn({ err }, "error al consultar driveFileSyncStore para digest");
      }
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("<i>Tocá el botón abajo para abrir el Snapshot Ejecutivo en vivo:</i>");

    const actionUrl = `${this.deps.appPublicUrl}/analitica`;

    const isMaskedToken =
      typeof input.botToken === "string" &&
      (input.botToken.includes("•") || input.botToken.includes("*"));
    const effectiveBotToken =
      !isMaskedToken && input.botToken && input.botToken.trim() !== ""
        ? input.botToken.trim()
        : (settings.botToken || "").trim();

    const result = await this.deps.sendTelegramAlert.execute({
      forced: input.forced,
      chatId: targetChatId,
      botToken: effectiveBotToken,
      category: "DIGEST",
      severity: "INFO",
      title: "Pulso Operativo Ejecutivo",
      body: lines.join("\n"),
      isHtmlBody: true,
      actions: [{ label: "📊 Ver Snapshot Ejecutivo", url: actionUrl }],
    });

    if (!result && input.forced) {
      throw businessError("No se pudo emitir el pulso a Telegram. Verificá que el bot esté agregado como miembro del grupo y que el Chat ID sea válido.");
    }

    this.deps.logger.info(
      { date: dateFormatted, time: timeFormatted, messageId: result?.messageId },
      "pulso operativo ejecutivo enviado a Telegram exitosamente",
    );

    return result;
  }
}


