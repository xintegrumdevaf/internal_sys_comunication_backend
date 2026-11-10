import type { Logger } from "../../../../../shared/logging/logger";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { EscalationRepositoryPort } from "../../../escalation/application/ports/escalation.repository.port";
import type { AnalyticsRepositoryPort } from "../../../analytics/application/ports/analytics.repository.port";
import type { SendTelegramAlertUseCase } from "./send-telegram-alert.use-case";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import type { AlertCooldownCacheService } from "../services/alert-cooldown-cache.service";

export interface CheckSystemAlertsDeps {
  caseRepo: CaseRepositoryPort;
  escalationRepo: EscalationRepositoryPort;
  analyticsRepo: AnalyticsRepositoryPort;
  sendTelegramAlert: SendTelegramAlertUseCase;
  getSettings: () => Promise<TelegramSettings>;
  cooldownCache: AlertCooldownCacheService;
  appPublicUrl: string;
  frontendUrl?: string;
  logger: Logger;
}

export interface CheckSystemAlertsResult {
  dispatchedCount: number;
  slaBreachesCount: number;
  queueDelaysCount: number;
  infraAlertsCount: number;
  alerts: Array<{ category: string; title: string; targetId: string }>;
}

export class CheckSystemAlertsUseCase {
  constructor(private readonly deps: CheckSystemAlertsDeps) {}

  async execute(): Promise<CheckSystemAlertsResult> {
    const settings = await this.deps.getSettings();

    if (!settings.enabled || !settings.defaultChatId) {
      return {
        dispatchedCount: 0,
        slaBreachesCount: 0,
        queueDelaysCount: 0,
        infraAlertsCount: 0,
        alerts: [],
      };
    }

    const alerts: Array<{ category: string; title: string; targetId: string }> = [];
    let slaBreachesCount = 0;
    let queueDelaysCount = 0;
    let infraAlertsCount = 0;

    const effectiveFrontendUrl = (
      (settings.frontendUrl && settings.frontendUrl.trim() !== "")
        ? settings.frontendUrl.trim()
        : (this.deps.frontendUrl || "http://localhost:8080")
    ).replace(/\/$/, "");

    // Resolver umbrales de reglas dinámicas o fallback a configuraciones legacy
    const resolveRule = (category: "SLA" | "INFRASTRUCTURE" | "QUEUE", defaultThreshold: number) => {
      if (settings.alertRules && settings.alertRules.length > 0) {
        const found = settings.alertRules.find((r) => r.category === category);
        if (found) {
          return { enabled: found.enabled, threshold: found.threshold };
        }
      }
      return { enabled: true, threshold: defaultThreshold };
    };

    const slaRule = resolveRule("SLA", settings.slaThresholdMinutes);
    const queueRule = resolveRule("QUEUE", settings.queueSaturationThreshold);
    const infraRule = resolveRule("INFRASTRUCTURE", settings.infraAlertMinCases);

    // 1. Detección de brechas de SLA en casos activos asignados a humanos (HUMAN_ACTIVE)
    if (slaRule.enabled && this.deps.caseRepo.findUnattendedHumanCases) {
      try {
        const unattendedCases = await this.deps.caseRepo.findUnattendedHumanCases(
          slaRule.threshold,
          5,
        );

        for (const item of unattendedCases) {
          const cooldownKey = `sla:case:${item.caseId}`;
          // Cooldown de 30 minutos por caso demorado
          if (!this.deps.cooldownCache.shouldAlert(cooldownKey, 30 * 60 * 1000)) {
            continue;
          }

          const title = `Demora excesiva en atención humana (${item.waitMinutes}m)`;
          const body = `El cliente ${item.customerName} (${item.customerPhone}) lleva ${item.waitMinutes} minutos esperando respuesta del asesor.`;
          const actionUrl = item.conversationId
            ? `${effectiveFrontendUrl}/bandeja?conversationId=${item.conversationId}&tab=unattended`
            : `${effectiveFrontendUrl}/bandeja?tab=unattended`;

          await this.deps.sendTelegramAlert.execute({
            category: "SLA",
            severity: "CRITICAL",
            title,
            body,
            metadata: {
              "Asesor": item.assignedAgentName,
              "Departamento": item.departmentName || "General",
              "Tiempo de espera": `${item.waitMinutes} minutos`,
              "Cliente": item.customerName,
            },
            actions: [{ label: "Abrir caso en Panel", url: actionUrl }],
          });

          slaBreachesCount++;
          alerts.push({ category: "SLA", title, targetId: item.caseId });
        }
      } catch (err) {
        this.deps.logger.warn({ err }, "error al evaluar brechas de SLA en casos humanos");
      }
    }

    // 2. Detección de clientes esperando en cola departamental (escalation PENDING)
    if (queueRule.enabled && this.deps.escalationRepo.findPendingDelayedEscalations) {
      try {
        const pendingQueue = await this.deps.escalationRepo.findPendingDelayedEscalations(
          queueRule.threshold,
          5,
        );

        for (const item of pendingQueue) {
          const cooldownKey = `sla:queue:${item.escalationId}`;
          if (!this.deps.cooldownCache.shouldAlert(cooldownKey, 30 * 60 * 1000)) {
            continue;
          }

          const title = `Cliente en cola de espera sin asignar (${item.waitMinutes}m)`;
          const body = `El cliente ${item.customerName} (${item.customerPhone}) aguarda en la cola de ${item.departmentName || "Triage"} sin ser tomado por un asesor.`;
          const actionUrl = `${effectiveFrontendUrl}/bandeja?tab=unassigned${item.departmentId ? `&departmentId=${item.departmentId}` : ""}`;

          await this.deps.sendTelegramAlert.execute({
            category: "QUEUE",
            severity: "WARNING",
            title,
            body,
            metadata: {
              "Departamento": item.departmentName || "Triage",
              "Prioridad": item.priority.toUpperCase(),
              "Tiempo en cola": `${item.waitMinutes} minutos`,
            },
            actions: [{ label: "Atender caso", url: actionUrl }],
          });

          queueDelaysCount++;
          alerts.push({ category: "QUEUE", title, targetId: item.escalationId });
        }
      } catch (err) {
        this.deps.logger.warn({ err }, "error al evaluar retrasos en cola de escalaciones");
      }
    }

    // 3. Detección de caídas masivas / anomalías de infraestructura OLT
    if (infraRule.enabled) {
      try {
        const now = new Date();
        const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

        const infraAlerts = await this.deps.analyticsRepo.getInfrastructureAlerts({
          from: thirtyMinutesAgo,
          to: now,
        });

        for (const item of infraAlerts) {
          if (item.activeCasesCount < infraRule.threshold) {
            continue;
          }

        const cooldownKey = `infra:${item.sector}:${item.oltName || "none"}`;
        // Cooldown de 45 minutos por sector
        if (!this.deps.cooldownCache.shouldAlert(cooldownKey, 45 * 60 * 1000)) {
          continue;
        }

        const title = `Alerta de Red: Concentración de fallas en ${item.sector}`;
        const body = `Se registraron ${item.activeCasesCount} reportes de fallas de servicio en los últimos 30 minutos asociados al sector ${item.sector}.`;
        const actionUrl = `${effectiveFrontendUrl}/configuracion`;

        await this.deps.sendTelegramAlert.execute({
          category: "INFRASTRUCTURE",
          severity: "CRITICAL",
          title,
          body,
          metadata: {
            "Sector": item.sector,
            "OLT": item.oltName || "Sin OLT identificada",
            "Casos Reportados": item.activeCasesCount,
          },
          actions: [{ label: "Ver Topología y Equipos", url: actionUrl }],
        });

        infraAlertsCount++;
        alerts.push({
          category: "INFRASTRUCTURE",
          title,
          targetId: `${item.sector}-${item.oltName}`,
        });
      }
    } catch (err) {
      this.deps.logger.warn({ err }, "error al evaluar anomalías de infraestructura de red");
    }
  }

    const dispatchedCount = slaBreachesCount + queueDelaysCount + infraAlertsCount;
    if (dispatchedCount > 0) {
      this.deps.logger.info(
        { dispatchedCount, slaBreachesCount, queueDelaysCount, infraAlertsCount },
        "centinela de Telegram despachó alertas reactivas",
      );
    }

    return {
      dispatchedCount,
      slaBreachesCount,
      queueDelaysCount,
      infraAlertsCount,
      alerts,
    };
  }
}
