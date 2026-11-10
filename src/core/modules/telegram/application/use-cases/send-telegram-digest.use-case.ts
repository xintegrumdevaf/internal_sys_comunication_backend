import type { Logger } from "../../../../../shared/logging/logger";
import type { AnalyticsRepositoryPort } from "../../../analytics/application/ports/analytics.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { SendTelegramAlertUseCase } from "./send-telegram-alert.use-case";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import type { TelegramMessageResult } from "../../domain/telegram-message.types";

export interface SendTelegramDigestDeps {
  analyticsRepo: AnalyticsRepositoryPort;
  caseRepo: CaseRepositoryPort;
  agentRepo: AgentRepositoryPort;
  sendTelegramAlert: SendTelegramAlertUseCase;
  getSettings: () => Promise<TelegramSettings>;
  appPublicUrl: string;
  logger: Logger;
}

export interface SendTelegramDigestInput {
  forced?: boolean;
  timeLabel?: string;
}

export class SendTelegramDigestUseCase {
  constructor(private readonly deps: SendTelegramDigestDeps) {}

  async execute(input: SendTelegramDigestInput = {}): Promise<TelegramMessageResult | null> {
    const settings = await this.deps.getSettings();

    if (!input.forced && (!settings.enabled || !settings.digestsEnabled || !settings.defaultChatId)) {
      this.deps.logger.debug("digests de Telegram deshabilitados; omitiendo envío");
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

    // 4. Formatear reporte ejecutivo en HTML
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
    const lines: string[] = [
      `📊 <b>PULSO OPERATIVO EJECUTIVO${labelHeader}</b>`,
      `🕒 <i>Corte: ${dateFormatted} a las ${timeFormatted} (${timeZone})</i>`,
      "",
      "📈 <b>Actividad del Día:</b>",
      `• <b>Casos Registrados:</b> <code>${overview.totalCases}</code>`,
      `• <b>Casos Resueltos:</b> <code>${overview.completedCases}</code>`,
      `• <b>Contención de IA:</b> <code>${Math.round(overview.botContainmentRate)}%</code> 🤖`,
      `• <b>Derivación Humana:</b> <code>${Math.round(overview.escalationRate)}%</code> 👤`,
    ];

    if (overview.avgQueueWaitTimeSeconds !== null || overview.avgResolutionTimeMinutes !== null) {
      lines.push("");
      lines.push("⏱️ <b>Velocidad de Respuesta:</b>");
      if (overview.avgQueueWaitTimeSeconds !== null) {
        lines.push(`• <b>Espera media en cola:</b> <code>${Math.round(overview.avgQueueWaitTimeSeconds)} seg</code>`);
      }
      if (overview.avgResolutionTimeMinutes !== null) {
        lines.push(`• <b>Tiempo medio de resolución:</b> <code>${Math.round(overview.avgResolutionTimeMinutes * 10) / 10} min</code>`);
      }
    }

    if (dashboard) {
      lines.push("");
      lines.push("👥 <b>Estado en Vivo en Este Instante:</b>");
      lines.push(`• <b>En atención humana activa:</b> <code>${dashboard.myAssignedCases || overview.activeCases}</code>`);
      lines.push(`• <b>En cola de espera:</b> <code>${dashboard.escalatedPending || 0}</code>`);
      lines.push(`• <b>Casos en seguimiento (En Espera):</b> <code>${dashboard.waitingUser || 0}</code>`);
      lines.push(`• <b>Asesores en turno disponibles:</b> <code>${activeAgentsCount}</code>`);

      if (dashboard.departmentBreakdown && dashboard.departmentBreakdown.length > 0) {
        lines.push("");
        lines.push("🏢 <b>Carga por Departamento:</b>");
        for (const dept of dashboard.departmentBreakdown) {
          const queuePart = dept.queueCases !== undefined ? ` | ${dept.queueCases} en cola` : "";
          lines.push(`• <b>${escapeHtml(dept.departmentName)}:</b> <code>${dept.activeCases} activos${queuePart}</code>`);
        }
      }
    }

    const actionUrl = `${this.deps.appPublicUrl}/analitica`;

    const result = await this.deps.sendTelegramAlert.execute({
      category: "DIGEST",
      severity: "INFO",
      title: "Pulso Operativo Ejecutivo",
      body: lines.join("\n"),
      actions: [{ label: "Abrir Analítica Completa", url: actionUrl }],
    });

    this.deps.logger.info(
      { date: dateFormatted, time: timeFormatted, messageId: result?.messageId },
      "pulso operativo ejecutivo enviado a Telegram exitosamente",
    );

    return result;
  }
}

function getStartOfDayInTimeZone(timeZone: string): Date {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (year && month && day) {
      return new Date(`${year}-${month}-${day}T00:00:00Z`);
    }
  } catch {
    // fallback a UTC midnight si la zona horaria fallara
  }
  const fallback = new Date();
  fallback.setUTCHours(0, 0, 0, 0);
  return fallback;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

