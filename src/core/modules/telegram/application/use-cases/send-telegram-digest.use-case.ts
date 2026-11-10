import { businessError } from "../../../../../shared/errors/domain-errors";
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

    // 4. Formatear reporte ejecutivo en Telegram HTML
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
    const isHeavyLoad = queuePending > 3;
    const healthStatus = isHeavyLoad ? "🟡 <i>Atención Requerida (demoras en cola)</i>" : "🟢 <i>Operación Normal y Fluida</i>";

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
        for (const dept of dashboard.departmentBreakdown) {
          const queuePart = dept.queueCases !== undefined ? ` | ${dept.queueCases} en cola` : "";
          lines.push(`• <b>${escapeHtml(dept.departmentName)}:</b> <b>${dept.activeCases} activos${queuePart}</b>`);
        }
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

