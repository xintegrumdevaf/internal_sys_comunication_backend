import type { Logger } from "../../../../../shared/logging/logger";
import type { AnalyticsRepositoryPort } from "../../../analytics/application/ports/analytics.repository.port";
import type {
  AgentPerformanceDto,
  AIEfficiencyDto,
  AnalyticsOverviewDto,
  CasesDistributionDto,
} from "../../../analytics/domain/analytics.types";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import type {
  TelegramInlineKeyboard,
  TelegramMessageResult,
} from "../../domain/telegram-message.types";
import {
  formatWorkflowDisplayName,
  getDaysAgoStartInTimeZone,
  getStartOfDayInTimeZone,
} from "../helpers/telegram-formatting.helper";
import type { TelegramAiCopilotPort } from "../ports/telegram-ai-copilot.port";
import type { TelegramGatewayPort } from "../ports/telegram-gateway.port";

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

const SYSTEM_ADMIN_CONTEXT = {
  actorId: "00000000-0000-0000-0000-000000000000",
  role: "admin" as const,
  targetUserId: "00000000-0000-0000-0000-000000000000",
  departmentIds: [] as string[],
  primaryDepartmentId: null,
};

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

    const classification = await this.deps.copilotPort.classifyQuestion(question);
    const timeZone = settings.timeZone || "America/Guayaquil";

    const effectiveFrontendUrl = (
      settings.frontendUrl && settings.frontendUrl.trim() !== ""
        ? settings.frontendUrl.trim()
        : this.deps.frontendUrl || "http://localhost:8080"
    ).replace(/\/$/, "");

    let groundTruth: string;
    let actionUrl = `${this.deps.appPublicUrl}/analitica`;
    let actionLabel = "📊 Ver Analítica";

    switch (classification.intent) {
      case "METRICS_OVERVIEW": {
        groundTruth = await this.collectMetricsOverviewGroundTruth(timeZone);
        break;
      }

      case "SLA_BREACHES": {
        const threshold = classification.minWaitMinutes || settings.slaThresholdMinutes || 15;
        groundTruth = await this.collectSlaGroundTruth(threshold, timeZone);
        actionUrl = `${effectiveFrontendUrl}/bandeja?tab=unattended`;
        actionLabel = "📂 Bandeja de Casos";
        break;
      }

      case "AGENTS_STATUS": {
        groundTruth = await this.collectAgentsGroundTruth(timeZone);
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
    const startOfDay = getStartOfDayInTimeZone(timeZone, now);
    const sevenDaysAgo = getDaysAgoStartInTimeZone(timeZone, 7, now);

    const [overview, distToday, aiEffToday, agentsPerfToday, dashboard, distLast7d, agents] = await Promise.all([
      this.safeCall(() => this.deps.analyticsRepo.getOverview({ from: startOfDay, to: now }), {
        totalCases: 0,
        completedCases: 0,
        activeCases: 0,
        botContainmentRate: 0,
        avgResolutionTimeMinutes: null,
        escalationRate: 0,
        avgQueueWaitTimeSeconds: null,
      } as AnalyticsOverviewDto),
      typeof this.deps.analyticsRepo.getCasesDistribution === "function"
        ? this.safeCall<CasesDistributionDto | null>(
            () => this.deps.analyticsRepo.getCasesDistribution({ from: startOfDay, to: now }),
            null,
          )
        : Promise.resolve(null),
      typeof this.deps.analyticsRepo.getAIEfficiency === "function"
        ? this.safeCall<AIEfficiencyDto | null>(
            () => this.deps.analyticsRepo.getAIEfficiency({ from: startOfDay, to: now }),
            null,
          )
        : Promise.resolve(null),
      typeof this.deps.analyticsRepo.getAgentsPerformance === "function"
        ? this.safeCall<AgentPerformanceDto[] | null>(
            () => this.deps.analyticsRepo.getAgentsPerformance({ from: startOfDay, to: now }, 5),
            null,
          )
        : Promise.resolve(null),
      typeof this.deps.caseRepo.getDashboardMetrics === "function"
        ? this.safeCall(() => this.deps.caseRepo.getDashboardMetrics(SYSTEM_ADMIN_CONTEXT), null)
        : Promise.resolve(null),
      typeof this.deps.analyticsRepo.getCasesDistribution === "function"
        ? this.safeCall<CasesDistributionDto | null>(
            () => this.deps.analyticsRepo.getCasesDistribution({ from: sevenDaysAgo, to: now }),
            null,
          )
        : Promise.resolve(null),
      typeof this.deps.agentRepo.list === "function"
        ? this.safeCall(() => this.deps.agentRepo.list(), [])
        : Promise.resolve([]),
    ]);

    const lines: string[] = [
      `=== MÉTRICAS DE HOY (${timeZone}) ===`,
      `- Zona horaria: ${timeZone}`,
      `- Total casos hoy: ${overview.totalCases}`,
      `- Casos resueltos: ${overview.completedCases}`,
      `- Casos activos en atención: ${overview.activeCases}`,
      `- Tasa de contención de IA (resuelto sin humano): ${Math.round(overview.botContainmentRate)}%`,
      `- Tasa de derivación a agentes humanos: ${Math.round(overview.escalationRate)}%`,
      overview.avgQueueWaitTimeSeconds !== null
        ? `- Espera promedio en cola: ${Math.round(overview.avgQueueWaitTimeSeconds)} segundos`
        : "- Espera en cola: dentro de lo normal",
    ];

    if (overview.avgResolutionTimeMinutes !== null && overview.avgResolutionTimeMinutes !== undefined) {
      lines.push(`- Tiempo promedio de resolución hoy: ${Math.round(overview.avgResolutionTimeMinutes * 10) / 10} min`);
    }
    if (overview.unassignedCases !== undefined) {
      lines.push(`- En cola sin asignar ahora: ${overview.unassignedCases}`);
    }
    if (overview.unattendedCases !== undefined) {
      lines.push(`- Casos asignados esperando respuesta humana ahora: ${overview.unattendedCases}`);
    }

    if (distToday) {
      lines.push("", "=== VENTAS, DEPARTAMENTOS Y GESTIONES HOY (desde 00:00) ===");
      const deptsToday = distToday.byDepartment?.filter((d) => d.count > 0) ?? [];
      lines.push(
        deptsToday.length > 0
          ? `- Casos ingresados hoy por Departamento: ${deptsToday.map((d) => `${d.departmentName} (${d.count})`).join(", ")}`
          : "- Casos ingresados hoy por Departamento: 0 nuevos ingresos en ningún departamento hoy",
      );

      const workflowsToday = distToday.byWorkflow.filter((w) => w.count > 0);
      lines.push(
        workflowsToday.length > 0
          ? `- Casos ingresados hoy por Tipo de Gestión: ${workflowsToday.map((w) => `${formatWorkflowDisplayName(w.workflowType)} [${w.workflowType}] (${w.count})`).join(", ")}`
          : "- Casos ingresados hoy por Tipo de Gestión (Ventas/Soporte/Facturación): 0 nuevos ingresos hoy",
      );

      if (distToday.topEscalationReasons.length > 0) {
        lines.push(
          `- Principales motivos de escalamiento hoy: ${distToday.topEscalationReasons
            .slice(0, 3)
            .map((r) => `${r.reason} (${r.count})`)
            .join(", ")}`,
        );
      }
    }

    const activeAgentsList = agents.filter((a) => a.active);
    const availableAgentsList = activeAgentsList.filter((a) => a.autoAssignEnabled);
    const humanActiveCases = agentsPerfToday
      ? agentsPerfToday.reduce((sum, a) => sum + a.activeCasesNow, 0)
      : dashboard
        ? dashboard.departmentBreakdown?.reduce(
            (sum, d) => sum + ((d as { handledCases?: number }).handledCases ?? 0),
            0,
          ) || Math.max(0, overview.activeCases - (dashboard.escalatedPending ?? 0) - (dashboard.waitingUser ?? 0))
        : overview.activeCases;

    if (dashboard || activeAgentsList.length > 0) {
      lines.push("", "=== OPERACIÓN EN VIVO AHORA MISMO (Casos Abiertos en Curso) ===");
      if (activeAgentsList.length > 0) {
        lines.push(
          `- Asesores en turno: ${activeAgentsList.length} activos (${availableAgentsList.length} disponibles para asignación)`,
        );
      }
      lines.push(`- En atención humana activa ahora (asignados a asesores): ${humanActiveCases}`);
      if (agentsPerfToday && agentsPerfToday.some((a) => a.activeCasesNow > 0)) {
        const busy = agentsPerfToday
          .filter((a) => a.activeCasesNow > 0)
          .map(
            (a) =>
              `${a.agentName} (${a.activeCasesNow} activos${a.unattendedActiveCases ? `, ${a.unattendedActiveCases} sin responder` : ""})`,
          );
        lines.push(`- Asesores atendiendo casos ahora: ${busy.join(", ")}`);
      }
      if (dashboard) {
        lines.push(`- En cola de espera sin asignar ahora: ${dashboard.escalatedPending}`);
        lines.push(`- Casos en seguimiento / espera del cliente ahora: ${dashboard.waitingUser}`);
        if (dashboard.departmentBreakdown && dashboard.departmentBreakdown.length > 0) {
          lines.push("- Carga abierta actual por Departamento:");
          for (const dept of dashboard.departmentBreakdown) {
            const queueText = dept.queueCases !== undefined ? ` | ${dept.queueCases} en cola` : "";
            lines.push(`  * ${dept.departmentName}: ${dept.activeCases} activos${queueText}`);
          }
        }
      }
    }

    if (aiEffToday || (agentsPerfToday && agentsPerfToday.length > 0)) {
      lines.push("", "=== EFICIENCIA IA Y CALIDAD EJECUTIVA ===");
      if (aiEffToday) {
        lines.push(
          `- IA hoy: ${aiEffToday.botCompletedCases} resueltos por bot | ${aiEffToday.humanEscalatedCases} escalados a humano | ${aiEffToday.unclearTriageCount} triage poco claro`,
        );
      }
      if (agentsPerfToday && agentsPerfToday.length > 0) {
        lines.push(...this.summarizeQualityMetrics(agentsPerfToday));
      }
    }

    if (distLast7d) {
      lines.push("", "=== RESUMEN ÚLTIMOS 7 DÍAS ===");
      lines.push(`- Total casos ingresados últimos 7 días: ${distLast7d.totalCases}`);
      const depts7d = distLast7d.byDepartment?.filter((d) => d.count > 0) ?? [];
      if (depts7d.length > 0) {
        lines.push(`- Últimos 7 días por Departamento: ${depts7d.map((d) => `${d.departmentName} (${d.count})`).join(", ")}`);
      }
      const workflows7d = distLast7d.byWorkflow.filter((w) => w.count > 0);
      if (workflows7d.length > 0) {
        lines.push(
          `- Últimos 7 días por Tipo de Gestión: ${workflows7d.map((w) => `${formatWorkflowDisplayName(w.workflowType)} (${w.count})`).join(", ")}`,
        );
      }
    }

    return lines.join("\n");
  }

  private summarizeQualityMetrics(agentsPerf: AgentPerformanceDto[]): string[] {
    const fcrValues = agentsPerf.map((a) => a.fcrRatePercentage).filter((v): v is number => v !== null);
    const cordValues = agentsPerf.map((a) => a.avgCordialityScore).filter((v): v is number => v !== null);
    const totalCompletedByHumans = agentsPerf.reduce((sum, a) => sum + a.casesCompleted, 0);
    const totalCriticalAlerts = agentsPerf.reduce((sum, a) => sum + a.criticalAlertsCount, 0);
    const totalCoaching = agentsPerf.reduce((sum, a) => sum + a.openCoachingNotesCount, 0);

    const avgFcr =
      fcrValues.length > 0
        ? `${Math.round(fcrValues.reduce((a, b) => a + b, 0) / fcrValues.length)}%`
        : "N/D";
    const avgCordiality =
      cordValues.length > 0
        ? `${Math.round(cordValues.reduce((a, b) => a + b, 0) / cordValues.length)}/100`
        : "N/D";

    return [
      `- Resueltos por asesores hoy: ${totalCompletedByHumans} | FCR promedio: ${avgFcr} | Cordialidad media: ${avgCordiality}`,
      `- Alertas críticas de calidad hoy: ${totalCriticalAlerts} | Notas coaching abiertas: ${totalCoaching}`,
    ];
  }

  private async collectSlaGroundTruth(thresholdMinutes: number, timeZone: string): Promise<string> {
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

    const startOfDay = getStartOfDayInTimeZone(timeZone);
    const overview = await this.safeCall(
      () => this.deps.analyticsRepo.getOverview({ from: startOfDay, to: new Date() }),
      null,
    );

    const queueContext =
      overview && overview.unassignedCases !== undefined
        ? ` En cola de espera sin asignar ahora: ${overview.unassignedCases}.`
        : "";

    if (cases.length === 0) {
      return `No hay casos demorados. Cero clientes superan el umbral de ${thresholdMinutes} minutos sin atención.${queueContext}`;
    }

    const items = cases.map(
      (c) =>
        `* Cliente: ${c.customerName} (${c.customerPhone}) - Espera: ${Math.round(c.waitMinutes)} min - Asesor: ${c.assignedAgentName || "Sin asignar"} - Depto: ${c.departmentName || "General"}`,
    );

    return [
      `Casos con demora superior a ${thresholdMinutes} minutos (${cases.length} detectados):${queueContext}`,
      ...items,
    ].join("\n");
  }

  private async collectAgentsGroundTruth(timeZone: string): Promise<string> {
    const agents = await this.deps.agentRepo.list();
    const active = agents.filter((a) => a.active);
    const available = active.filter((a) => a.autoAssignEnabled);

    const startOfDay = getStartOfDayInTimeZone(timeZone);
    let perfMap = new Map<string, AgentPerformanceDto>();

    if (typeof this.deps.analyticsRepo.getAgentsPerformance === "function") {
      const perfs = await this.safeCall(
        () => this.deps.analyticsRepo.getAgentsPerformance({ from: startOfDay, to: new Date() }, 5),
        [] as AgentPerformanceDto[],
      );
      perfMap = new Map(perfs.map((p) => [p.agentId, p]));
    }

    const list = active.map((a) => {
      const perf = perfMap.get(a.id);
      const perfDetails: string[] = [];
      if (perf) {
        perfDetails.push(`activos ahora: ${perf.activeCasesNow}/${perf.maxCapacityThreshold}`);
        perfDetails.push(`resueltos hoy: ${perf.casesCompleted}`);
        if (perf.fcrRatePercentage !== null) {
          perfDetails.push(`FCR: ${Math.round(perf.fcrRatePercentage)}%`);
        }
        if (perf.avgCordialityScore !== null) {
          perfDetails.push(`cordialidad: ${Math.round(perf.avgCordialityScore)}/100`);
        }
        if (perf.unattendedActiveCases) {
          perfDetails.push(`sin responder: ${perf.unattendedActiveCases}`);
        }
      }
      const suffix = perfDetails.length > 0 ? ` [${perfDetails.join(", ")}]` : "";
      return `* ${a.name} (${a.role}): ${a.autoAssignEnabled ? "Disponible para asignación" : "Asignación pausada"}${suffix}`;
    });

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
      const s = normalizeForMatch(sectorFilter);
      alerts = alerts.filter((a) => normalizeForMatch(a.sector).includes(s));
    }

    if (alerts.length === 0) {
      return `Red e infraestructura 100% normal. No hay cortes ni concentración anómala de reclamos en OLTs${sectorFilter ? ` para el sector "${sectorFilter}"` : ""}.`;
    }

    const list = alerts.map(
      (a) =>
        `* Sector: ${a.sector} - OLT: ${a.oltName || "Desconocida"} - Casos activos: ${a.activeCasesCount} - Severidad: ${a.isHighVolumeAlert ? "Corte masivo" : "Incidencia zonal"}`,
    );

    return [`Alertas de red detectadas (${alerts.length} zonas):`, ...list].join("\n");
  }

  private async safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
