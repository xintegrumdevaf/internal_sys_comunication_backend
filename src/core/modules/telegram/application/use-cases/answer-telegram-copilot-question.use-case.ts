import type { Logger } from "../../../../../shared/logging/logger";
import type { AnalyticsRepositoryPort } from "../../../analytics/application/ports/analytics.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { TelegramGatewayPort } from "../ports/telegram-gateway.port";
import type { TelegramAiCopilotPort } from "../ports/telegram-ai-copilot.port";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import type {
  TelegramInlineKeyboard,
  TelegramMessageResult,
} from "../../domain/telegram-message.types";

export interface AnswerTelegramCopilotQuestionDeps {
  copilotPort: TelegramAiCopilotPort;
  gateway: TelegramGatewayPort;
  caseRepo: CaseRepositoryPort;
  agentRepo: AgentRepositoryPort;
  analyticsRepo: AnalyticsRepositoryPort;
  getSettings: () => Promise<TelegramSettings>;
  appPublicUrl: string;
  frontendUrl?: string;
  logger: Logger;
}

export interface AnswerCopilotQuestionInput {
  question: string;
  chatId: string;
  messageThreadId?: number;
}

export class AnswerTelegramCopilotQuestionUseCase {
  constructor(private readonly deps: AnswerTelegramCopilotQuestionDeps) {}

  async execute(input: AnswerCopilotQuestionInput): Promise<TelegramMessageResult | null> {
    const { question, chatId, messageThreadId } = input;
    const settings = await this.deps.getSettings();

    if (!settings.aiCopilotEnabled) {
      this.deps.logger.debug("copilot de IA en Telegram no habilitado");
      return null;
    }

    this.deps.logger.info({ question, chatId }, "procesando pregunta en lenguaje natural con Copilot");

    // 1. Clasificar intención operativa con IA
    const classification = await this.deps.copilotPort.classifyQuestion(question);

    // 2. Extraer Ground Truth real de la base de datos según la intención
    const effectiveFrontendUrl = (
      (settings.frontendUrl && settings.frontendUrl.trim() !== "")
        ? settings.frontendUrl.trim()
        : (this.deps.frontendUrl || "http://localhost:8080")
    ).replace(/\/$/, "");

    let groundTruth: string;
    let actionUrl = `${this.deps.appPublicUrl}/analitica`;
    let actionLabel = "📊 Ver Analítica";

    switch (classification.intent) {
      case "METRICS_OVERVIEW": {
        groundTruth = await this.collectMetricsOverviewGroundTruth(settings.timeZone);
        break;
      }

      case "SLA_BREACHES": {
        const threshold = classification.minWaitMinutes || settings.slaThresholdMinutes || 15;
        groundTruth = await this.collectSlaGroundTruth(threshold);
        actionUrl = `${effectiveFrontendUrl}/bandeja?tab=unattended`;
        actionLabel = "📂 Bandeja de Casos";
        break;
      }

      case "AGENTS_STATUS": {
        groundTruth = await this.collectAgentsGroundTruth();
        break;
      }

      case "INFRA_ALERTS": {
        groundTruth = await this.collectInfraGroundTruth(
          settings.infraAlertMinCases || 3,
          classification.sector,
        );
        break;
      }

      case "OUT_OF_SCOPE":
      default: {
        groundTruth = "OUT_OF_SCOPE";
        break;
      }
    }

    // 3. Sintetizar respuesta ejecutiva en HTML
    const formattedHtml = await this.deps.copilotPort.synthesizeReply({
      question,
      intent: classification.intent,
      groundTruth,
    });

    const replyMarkup: TelegramInlineKeyboard = {
      inline_keyboard: [
        [{ text: actionLabel, url: actionUrl }],
        [
          { text: "📊 Resumen", callback_data: "cmd:resumen" },
          { text: "⏱️ SLA", callback_data: "cmd:sla" },
          { text: "👥 Asesores", callback_data: "cmd:agentes" },
        ],
      ],
    };

    // 4. Enviar respuesta al chat
    return this.deps.gateway.sendMessage(
      {
        chatId,
        messageThreadId,
        text: formattedHtml,
        replyMarkup,
      },
      settings.botToken,
    );
  }

  private async collectMetricsOverviewGroundTruth(timeZone: string): Promise<string> {
    const now = new Date();
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    let overview;
    try {
      overview = await this.deps.analyticsRepo.getOverview({ from: startOfDay, to: now });
    } catch {
      overview = {
        totalCases: 0,
        completedCases: 0,
        activeCases: 0,
        botContainmentRate: 0,
        escalationRate: 0,
        avgQueueWaitTimeSeconds: null,
      };
    }

    return [
      `- Zona horaria: ${timeZone}`,
      `- Total casos hoy: ${overview.totalCases}`,
      `- Casos resueltos: ${overview.completedCases}`,
      `- Casos activos en atención: ${overview.activeCases}`,
      `- Tasa de contención de IA (resuelto sin humano): ${Math.round(overview.botContainmentRate)}%`,
      `- Tasa de derivación a agentes humanos: ${Math.round(overview.escalationRate)}%`,
      overview.avgQueueWaitTimeSeconds !== null
        ? `- Espera promedio en cola: ${Math.round(overview.avgQueueWaitTimeSeconds)} segundos`
        : "- Espera en cola: dentro de lo normal",
    ].join("\n");
  }

  private async collectSlaGroundTruth(thresholdMinutes: number): Promise<string> {
    let cases: Array<{
      customerName: string;
      customerPhone: string;
      assignedAgentName?: string | null;
      departmentName?: string | null;
      waitMinutes: number;
    }> = [];

    if (this.deps.caseRepo.findUnattendedHumanCases) {
      cases = await this.deps.caseRepo.findUnattendedHumanCases(thresholdMinutes, 10);
    }

    if (cases.length === 0) {
      return `No hay casos demorados. Cero clientes superan el umbral de ${thresholdMinutes} minutos sin atención.`;
    }

    const items = cases.map(
      (c) =>
        `* Cliente: ${c.customerName} (${c.customerPhone}) - Espera: ${Math.round(c.waitMinutes)} min - Asesor: ${c.assignedAgentName || "Sin asignar"} - Depto: ${c.departmentName || "General"}`,
    );

    return [
      `Casos con demora superior a ${thresholdMinutes} minutos (${cases.length} detectados):`,
      ...items,
    ].join("\n");
  }

  private async collectAgentsGroundTruth(): Promise<string> {
    const agents = await this.deps.agentRepo.list();
    const active = agents.filter((a) => a.active);
    const available = active.filter((a) => a.autoAssignEnabled);

    const list = active.map(
      (a) =>
        `* ${a.name} (${a.role}): ${a.autoAssignEnabled ? "Disponible para asignación" : "Asignación pausada"}`,
    );

    return [
      `Total asesores activos en el turno: ${active.length}`,
      `Asesores disponibles para recibir nuevos casos: ${available.length}`,
      ...list,
    ].join("\n");
  }

  private async collectInfraGroundTruth(minCases: number, sectorFilter?: string): Promise<string> {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const raw = await this.deps.analyticsRepo.getInfrastructureAlerts({
      from: twoHoursAgo,
      to: now,
    });

    let alerts = raw.filter((a) => a.activeCasesCount >= minCases);
    if (sectorFilter && sectorFilter.trim() !== "") {
      const s = sectorFilter.toLowerCase();
      alerts = alerts.filter((a) => a.sector.toLowerCase().includes(s));
    }

    if (alerts.length === 0) {
      return `Red e infraestructura 100% normal. No hay cortes ni concentración anómala de reclamos en OLTs${sectorFilter ? ` para el sector "${sectorFilter}"` : ""}.`;
    }

    const list = alerts.map(
      (a) =>
        `* Sector: ${a.sector} - OLT: ${a.oltName || "Desconocida"} - Casos activos: ${a.activeCasesCount} - Severidad: ${a.isHighVolumeAlert ? "Corte masivo" : "Incidencia zonal"}`,
    );

    return [
      `Alertas de red detectadas (${alerts.length} zonas):`,
      ...list,
    ].join("\n");
  }
}
