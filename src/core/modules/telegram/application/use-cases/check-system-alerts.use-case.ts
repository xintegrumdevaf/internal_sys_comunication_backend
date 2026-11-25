import type { Logger } from "../../../../../shared/logging/logger";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { EscalationRepositoryPort } from "../../../escalation/application/ports/escalation.repository.port";
import type { AnalyticsRepositoryPort } from "../../../analytics/application/ports/analytics.repository.port";
import type { SendTelegramAlertUseCase } from "./send-telegram-alert.use-case";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import {
  DEFAULT_TELEGRAM_DRIVE_MONITOR,
  computeDriveFileStaleness,
  formatDriveTimestamp,
  formatDurationMinutes,
  formatElapsedHoursLabel,
} from "../../domain/drive-file-sync.entity";
import type { DriveFileSyncStorePort } from "../ports/drive-file-sync.store.port";
import type { AlertCooldownCacheService } from "../services/alert-cooldown-cache.service";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

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
  broadcaster?: RealtimeBroadcaster;
  driveFileSyncStore?: DriveFileSyncStorePort;
}

export interface CheckSystemAlertsResult {
  dispatchedCount: number;
  slaBreachesCount: number;
  queueDelaysCount: number;
  infraAlertsCount: number;
  driveAlertsCount: number;
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
        driveAlertsCount: 0,
        alerts: [],
      };
    }

    const alerts: Array<{ category: string; title: string; targetId: string }> = [];
    let slaBreachesCount = 0;
    let queueDelaysCount = 0;
    let infraAlertsCount = 0;
    let driveAlertsCount = 0;

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
          const isUnassigned = !item.assignedAgentId;
          const cooldownKey = `sla:case:${item.caseId}`;
          // Cooldown de 30 minutos por caso demorado
          const canAlert =
            typeof this.deps.cooldownCache.shouldAlertAsync === "function"
              ? await this.deps.cooldownCache.shouldAlertAsync(cooldownKey, 30 * 60 * 1000)
              : this.deps.cooldownCache.shouldAlert(cooldownKey, 30 * 60 * 1000);
          if (!canAlert) {
            continue;
          }

          const waitLabel = formatDurationMinutes(item.waitMinutes);
          const title = isUnassigned
            ? `⚠️ Caso SIN ASIGNAR con demora excesiva (${waitLabel})`
            : `Demora excesiva en atención humana (${waitLabel})`;
          const body = isUnassigned
            ? `El cliente ${item.customerName} (${item.customerPhone}) lleva ${waitLabel} esperando atención en ${item.departmentName || "General / Sin área"}. Ningún asesor ha tomado el caso.`
            : `El cliente ${item.customerName} (${item.customerPhone}) lleva ${waitLabel} esperando respuesta del asesor.`;
          const actionUrl = item.conversationId
            ? `${effectiveFrontendUrl}/bandeja?conversationId=${item.conversationId}&status=open`
            : `${effectiveFrontendUrl}/bandeja?tab=unassigned`;

          // 1. Notificación a Telegram (con prioridad al departamento si tiene área)
          await this.deps.sendTelegramAlert.execute({
            category: "SLA",
            severity: "CRITICAL",
            title,
            body,
            metadata: {
              "Estado": isUnassigned ? "Sin asignar (En cola)" : "Asignado",
              "Asesor": item.assignedAgentName || "Sin asignar",
              "Departamento": item.departmentName || "General",
              "Tiempo de espera": waitLabel,
              "Cliente": item.customerName,
            },
            actions: [{ label: isUnassigned ? "Tomar / Atender caso" : "Abrir caso en Panel", url: actionUrl }],
          });

          // 2. Notificación en tiempo real dentro de la app (SSE para agentes del área y managers/admins)
          if (isUnassigned && this.deps.broadcaster && item.conversationId) {
            this.deps.broadcaster.publish({
              type: "UNASSIGNED_SLA_BREACH",
              caseId: item.caseId,
              conversationId: item.conversationId,
              departmentId: item.departmentId,
              departmentName: item.departmentName,
              waitMinutes: item.waitMinutes,
              customerName: item.customerName,
              customerPhone: item.customerPhone,
            });
          }

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
          const canAlert =
            typeof this.deps.cooldownCache.shouldAlertAsync === "function"
              ? await this.deps.cooldownCache.shouldAlertAsync(cooldownKey, 30 * 60 * 1000)
              : this.deps.cooldownCache.shouldAlert(cooldownKey, 30 * 60 * 1000);
          if (!canAlert) {
            continue;
          }

          const queueWaitLabel = formatDurationMinutes(item.waitMinutes);
          const title = `Cliente en cola de espera sin asignar (${queueWaitLabel})`;
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
              "Tiempo en cola": queueWaitLabel,
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
        const canAlertInfra =
          typeof this.deps.cooldownCache.shouldAlertAsync === "function"
            ? await this.deps.cooldownCache.shouldAlertAsync(cooldownKey, 45 * 60 * 1000)
            : this.deps.cooldownCache.shouldAlert(cooldownKey, 45 * 60 * 1000);
        if (!canAlertInfra) {
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

    // 4. Detección de archivos desactualizados en Google Drive según temporizador configurable (horas)
    const driveSettings = settings.driveMonitor ?? DEFAULT_TELEGRAM_DRIVE_MONITOR;
    if (driveSettings.enabled && driveSettings.notifyOnStale && this.deps.driveFileSyncStore) {
      try {
        const syncState = await this.deps.driveFileSyncStore.getState();
        const timeZone = settings.timeZone || "America/Guayaquil";

        for (const fileCfg of driveSettings.files) {
          if (!fileCfg.enabled) continue;
          const record = syncState.records[fileCfg.key];
          if (!record?.lastModifiedTime) continue;

          const thresholdHours =
            fileCfg.staleThresholdHours ?? driveSettings.staleThresholdHours ?? 24;
          const { elapsedHours, isStale } = computeDriveFileStaleness(
            record.lastModifiedTime,
            thresholdHours,
          );
          if (!isStale || elapsedHours === null) continue;

          const cooldownMs = Math.max(60, Math.min(thresholdHours * 60, 360)) * 60 * 1000;
          const cooldownKey = `drive:stale:${fileCfg.key}`;
          const canAlertDrive =
            typeof this.deps.cooldownCache.shouldAlertAsync === "function"
              ? await this.deps.cooldownCache.shouldAlertAsync(cooldownKey, cooldownMs)
              : this.deps.cooldownCache.shouldAlert(cooldownKey, cooldownMs);
          if (!canAlertDrive) {
            continue;
          }

          const elapsedLabel = formatElapsedHoursLabel(elapsedHours);
          const thresholdLabel = formatElapsedHoursLabel(thresholdHours);
          const formattedModified = formatDriveTimestamp(record.lastModifiedTime, timeZone);
          const editorDisplay =
            record.lastModifiedBy ||
            record.lastModifiedByEmail ||
            "Usuario no reportado por Drive";
          const title = `Archivo sin actualizar en Drive: ${record.fileName} (${elapsedLabel})`;
          const body = `El archivo ${fileCfg.label} (${record.fileName}) lleva ${elapsedLabel} sin modificaciones en Google Drive, superando el temporizador configurado de ${thresholdLabel}.`;

          await this.deps.sendTelegramAlert.execute({
            category: "DRIVE_SYNC",
            severity: "WARNING",
            title,
            body,
            metadata: {
              "Archivo": `${fileCfg.label} (${fileCfg.key})`,
              "Nombre en Drive": record.fileName,
              "Tiempo sin cambios": elapsedLabel,
              "Temporizador configurado": thresholdLabel,
              "Última modificación": formattedModified,
              "Último editor": editorDisplay,
            },
            actions: [
              ...(record.webViewLink
                ? [{ label: "📄 Abrir archivo en Drive", url: record.webViewLink }]
                : []),
              {
                label: "⚙️ Ajustar Monitor en Panel",
                url: `${effectiveFrontendUrl}/configuracion`,
              },
            ],
          });

          driveAlertsCount++;
          alerts.push({
            category: "DRIVE_SYNC",
            title,
            targetId: fileCfg.key,
          });
        }
      } catch (err) {
        this.deps.logger.warn({ err }, "error al evaluar frescura de archivos en Google Drive");
      }
    }

    const dispatchedCount =
      slaBreachesCount + queueDelaysCount + infraAlertsCount + driveAlertsCount;
    if (dispatchedCount > 0) {
      this.deps.logger.info(
        {
          dispatchedCount,
          slaBreachesCount,
          queueDelaysCount,
          infraAlertsCount,
          driveAlertsCount,
        },
        "centinela de Telegram despachó alertas reactivas",
      );
    }

    return {
      dispatchedCount,
      slaBreachesCount,
      queueDelaysCount,
      infraAlertsCount,
      driveAlertsCount,
      alerts,
    };
  }
}
