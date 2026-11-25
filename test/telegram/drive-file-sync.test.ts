import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/shared/config/env";
import type { Logger } from "../../src/shared/logging/logger";
import type { DriveFileSyncStorePort } from "../../src/core/modules/telegram/application/ports/drive-file-sync.store.port";
import type { TelegramGatewayPort } from "../../src/core/modules/telegram/application/ports/telegram-gateway.port";
import { AlertCooldownCacheService } from "../../src/core/modules/telegram/application/services/alert-cooldown-cache.service";
import { CheckSystemAlertsUseCase } from "../../src/core/modules/telegram/application/use-cases/check-system-alerts.use-case";
import { ReportDriveFileSyncUseCase } from "../../src/core/modules/telegram/application/use-cases/report-drive-file-sync.use-case";
import { SendTelegramAlertUseCase } from "../../src/core/modules/telegram/application/use-cases/send-telegram-alert.use-case";
import { SendTelegramDigestUseCase } from "../../src/core/modules/telegram/application/use-cases/send-telegram-digest.use-case";
import {
  DEFAULT_DRIVE_MONITORED_FILES,
  DEFAULT_TELEGRAM_DRIVE_MONITOR,
  type DriveFileSyncState,
  formatDurationMinutes,
  matchDriveFileConfig,
} from "../../src/core/modules/telegram/domain/drive-file-sync.entity";
import {
  DEFAULT_TELEGRAM_ALERT_RULES,
  DEFAULT_TELEGRAM_TOPICS,
  type TelegramSettings,
} from "../../src/core/modules/telegram/domain/telegram-config.entity";
import { createDriveSyncIntegrationRouter } from "../../src/core/modules/telegram/presentation/drive-sync-integration.router";
import type { AnalyticsRepositoryPort } from "../../src/core/modules/analytics/application/ports/analytics.repository.port";
import type { CaseRepositoryPort } from "../../src/core/modules/cases/application/ports/case.repository.port";
import type { EscalationRepositoryPort } from "../../src/core/modules/escalation/application/ports/escalation.repository.port";
import type { AgentRepositoryPort } from "../../src/core/modules/departments/application/ports/agent.repository.port";

const nullLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => nullLogger,
} as unknown as Logger;

function buildSettings(overrides?: Partial<TelegramSettings>): TelegramSettings {
  return {
    enabled: true,
    botToken: "123456:token-valid",
    defaultChatId: "-1001234567890",
    topicsEnabled: false,
    topics: DEFAULT_TELEGRAM_TOPICS,
    slaTopicId: null,
    infraTopicId: null,
    digestsTopicId: null,
    digestsEnabled: true,
    digestHours: ["09:00", "14:00", "19:00"],
    timeZone: "America/Guayaquil",
    alertRules: DEFAULT_TELEGRAM_ALERT_RULES,
    slaThresholdMinutes: 15,
    infraAlertMinCases: 3,
    queueSaturationThreshold: 10,
    webhookSecret: "",
    commandsEnabled: true,
    aiCopilotEnabled: false,
    driveMonitor: {
      ...DEFAULT_TELEGRAM_DRIVE_MONITOR,
      staleThresholdHours: 24,
      files: DEFAULT_DRIVE_MONITORED_FILES.map((f) => ({ ...f })),
    },
    frontendUrl: "http://localhost:8080",
    ...overrides,
  };
}

class InMemoryDriveFileSyncStore implements DriveFileSyncStorePort {
  public state: DriveFileSyncState = { updatedAt: null, records: {} };

  async getState(): Promise<DriveFileSyncState> {
    return this.state;
  }

  async saveState(state: DriveFileSyncState): Promise<void> {
    this.state = state;
  }
}

describe("Google Drive File Monitor & Telegram Alerts", () => {
  it("reconoce CONTRATOS y CARTERA por fileId o por alias de nombre tras re-subida", () => {
    const byId = matchDriveFileConfig(DEFAULT_DRIVE_MONITORED_FILES, {
      fileId: "1wFaJYgCPCLmN3nPEah_NFNaS3l4XQccJJ8i9D48bsMo",
      fileName: "Archivo Renombrado",
    });
    expect(byId?.key).toBe("CONTRATOS");

    const byAlias = matchDriveFileConfig(DEFAULT_DRIVE_MONITORED_FILES, {
      fileId: "nuevo-id-tras-reupload",
      fileName: "reporte_contratos.xlsx",
    });
    expect(byAlias?.key).toBe("CONTRATOS");

    const carteraAlias = matchDriveFileConfig(DEFAULT_DRIVE_MONITORED_FILES, {
      fileId: "otro-id",
      fileName: "Cartera Mensual.xlsx",
    });
    expect(carteraAlias?.key).toBe("CARTERA");
  });

  it("inicializa baseline en el primer reporte y notifica a Telegram con editor y hora cuando se modifica", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      messageId: 42,
      chatId: "-1001234567890",
      date: Math.floor(Date.now() / 1000),
    });
    const gateway: TelegramGatewayPort = {
      getMe: vi.fn(),
      sendMessage,
      answerCallbackQuery: vi.fn(),
      setWebhook: vi.fn(),
    };
    const store = new InMemoryDriveFileSyncStore();
    const cooldownCache = new AlertCooldownCacheService();
    const settings = buildSettings();
    const sendTelegramAlert = new SendTelegramAlertUseCase({
      gateway,
      getSettings: async () => settings,
      logger: nullLogger,
    });
    const reportUseCase = new ReportDriveFileSyncUseCase({
      driveFileSyncStore: store,
      sendTelegramAlert,
      getSettings: async () => settings,
      cooldownCache,
      logger: nullLogger,
    });

    // 1. Baseline inicial: guarda sin disparar alerta falsa
    const first = await reportUseCase.execute({
      files: [
        {
          fileName: "CONTRATOS",
          fileId: "1wFaJYgCPCLmN3nPEah_NFNaS3l4XQccJJ8i9D48bsMo",
          modifiedTime: "2026-11-25T13:00:00.000Z",
          modifiedBy: "María Pérez",
          modifiedByEmail: "maria@isp.local",
        },
      ],
    });
    expect(first.initializedCount).toBe(1);
    expect(first.alertsDispatched).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();

    // 2. Sin cambios: no envía alerta
    const second = await reportUseCase.execute({
      files: [
        {
          fileName: "CONTRATOS",
          modifiedTime: "2026-11-25T13:00:00.000Z",
          modifiedBy: "María Pérez",
        },
      ],
    });
    expect(second.changedCount).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();

    // 3. Modificación detectada: envía alerta inmediata con quién y a qué hora
    const third = await reportUseCase.execute({
      files: [
        {
          fileName: "CONTRATOS",
          modifiedTime: "2026-11-25T15:30:00.000Z",
          modifiedBy: "Carlos Gómez",
          modifiedByEmail: "carlos@isp.local",
          webViewLink: "https://docs.google.com/spreadsheets/d/1wFaJYgCPCLmN3nPEah_NFNaS3l4XQccJJ8i9D48bsMo",
        },
      ],
    });

    expect(third.changedCount).toBe(1);
    expect(third.alertsDispatched).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const payload = sendMessage.mock.calls[0]?.[0];
    expect(payload.text).toContain("CONTRATOS");
    expect(payload.text).toContain("Carlos Gómez");
    expect(payload.text).toContain("carlos@isp.local");
    expect(store.state.records["CONTRATOS"]?.lastModifiedBy).toBe("Carlos Gómez");
  });

  it("dispara alerta de desactualización cuando supera el temporizador configurable de horas", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      messageId: 77,
      chatId: "-1001234567890",
      date: Math.floor(Date.now() / 1000),
    });
    const gateway: TelegramGatewayPort = {
      getMe: vi.fn(),
      sendMessage,
      answerCallbackQuery: vi.fn(),
      setWebhook: vi.fn(),
    };
    const settings = buildSettings({
      driveMonitor: {
        enabled: true,
        staleThresholdHours: 6,
        notifyOnModification: true,
        notifyOnStale: true,
        files: [
          {
            key: "CARTERA",
            label: "Cartera y Saldos",
            expectedFileName: "CARTERA",
            expectedSheetName: "Sheet",
            fileId: "1_kI__kiJjHEWoaC6YKtH1Bm1Yc6ZylWEAj_8rb7pbKY",
            staleThresholdHours: null,
            enabled: true,
          },
        ],
      },
    });
    const store = new InMemoryDriveFileSyncStore();
    const eightHoursAgo = new Date(Date.now() - 8 * 3_600_000).toISOString();
    store.state = {
      updatedAt: eightHoursAgo,
      records: {
        CARTERA: {
          fileKey: "CARTERA",
          label: "Cartera y Saldos",
          fileId: "1_kI__kiJjHEWoaC6YKtH1Bm1Yc6ZylWEAj_8rb7pbKY",
          fileName: "CARTERA",
          expectedFileName: "CARTERA",
          expectedSheetName: "Sheet",
          mimeType: "application/vnd.google-apps.spreadsheet",
          lastModifiedTime: eightHoursAgo,
          previousModifiedTime: null,
          lastModifiedBy: "Ana Torres",
          lastModifiedByEmail: "ana@isp.local",
          webViewLink: null,
          version: "12",
          lastReportedAt: eightHoursAgo,
          lastNotifiedModifiedTime: null,
        },
      },
    };

    const sendTelegramAlert = new SendTelegramAlertUseCase({
      gateway,
      getSettings: async () => settings,
      logger: nullLogger,
    });
    const checkAlerts = new CheckSystemAlertsUseCase({
      caseRepo: { findUnattendedHumanCases: vi.fn().mockResolvedValue([]) } as unknown as CaseRepositoryPort,
      escalationRepo: { findPendingDelayedEscalations: vi.fn().mockResolvedValue([]) } as unknown as EscalationRepositoryPort,
      analyticsRepo: { getInfrastructureAlerts: vi.fn().mockResolvedValue([]) } as unknown as AnalyticsRepositoryPort,
      sendTelegramAlert,
      getSettings: async () => settings,
      cooldownCache: new AlertCooldownCacheService(),
      appPublicUrl: "http://localhost:3000",
      frontendUrl: "http://localhost:8080",
      logger: nullLogger,
      driveFileSyncStore: store,
    });

    const firstRun = await checkAlerts.execute();
    expect(firstRun.driveAlertsCount).toBe(1);
    expect(firstRun.dispatchedCount).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const alertText = sendMessage.mock.calls[0]?.[0]?.text ?? "";
    expect(alertText).toContain("CARTERA");
    expect(alertText).toContain("8 horas");
    expect(alertText).toContain("6 horas");
    expect(alertText).toContain("Ana Torres");
    expect(formatDurationMinutes(25)).toBe("25 minutos");
    expect(formatDurationMinutes(185)).toBe("3 horas y 5 minutos");
    expect(formatDurationMinutes(57 * 1440 + 2 * 60 + 48)).toBe(
      "57 días, 2 horas y 48 minutos",
    );

    // Cooldown evita spam inmediato en la siguiente ejecución
    const secondRun = await checkAlerts.execute();
    expect(secondRun.driveAlertsCount).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("incluye el estado de archivos en Google Drive dentro del Pulso Operativo Ejecutivo", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      messageId: 99,
      chatId: "-1001234567890",
      date: Math.floor(Date.now() / 1000),
    });
    const gateway: TelegramGatewayPort = {
      getMe: vi.fn(),
      sendMessage,
      answerCallbackQuery: vi.fn(),
      setWebhook: vi.fn(),
    };
    const settings = buildSettings();
    const store = new InMemoryDriveFileSyncStore();
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    store.state = {
      updatedAt: oneHourAgo,
      records: {
        CONTRATOS: {
          fileKey: "CONTRATOS",
          label: "Contratos de Clientes",
          fileId: "id-contratos",
          fileName: "CONTRATOS",
          expectedFileName: "CONTRATOS",
          expectedSheetName: "ReporteContratos",
          mimeType: null,
          lastModifiedTime: oneHourAgo,
          previousModifiedTime: null,
          lastModifiedBy: "Luis Mora",
          lastModifiedByEmail: null,
          webViewLink: null,
          version: null,
          lastReportedAt: oneHourAgo,
          lastNotifiedModifiedTime: null,
        },
      },
    };

    const sendTelegramAlert = new SendTelegramAlertUseCase({
      gateway,
      getSettings: async () => settings,
      logger: nullLogger,
    });
    const sendDigest = new SendTelegramDigestUseCase({
      analyticsRepo: {
        getOverview: vi.fn().mockResolvedValue({
          totalCases: 5,
          activeCases: 2,
          completedCases: 3,
          botContainmentRate: 60,
          avgResolutionTimeMinutes: 4,
          avgQueueWaitTimeSeconds: 20,
          escalationRate: 40,
        }),
        getCasesDistribution: vi.fn().mockResolvedValue({ byWorkflow: [] }),
        getInfrastructureAlerts: vi.fn().mockResolvedValue([]),
      } as unknown as AnalyticsRepositoryPort,
      caseRepo: {
        getDashboardMetrics: vi.fn().mockResolvedValue({
          escalatedPending: 0,
          myAssignedCases: 1,
          waitingUser: 0,
          departmentBreakdown: [],
        }),
        findUnattendedHumanCases: vi.fn().mockResolvedValue([]),
      } as unknown as CaseRepositoryPort,
      agentRepo: { list: vi.fn().mockResolvedValue([]) } as unknown as AgentRepositoryPort,
      sendTelegramAlert,
      getSettings: async () => settings,
      appPublicUrl: "http://localhost:3000",
      logger: nullLogger,
      driveFileSyncStore: store,
    });

    await sendDigest.execute({ forced: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const bodyText = sendMessage.mock.calls[0]?.[0]?.text ?? "";
    expect(bodyText).toContain("ARCHIVOS EN GOOGLE DRIVE");
    expect(bodyText).toContain("CONTRATOS");
    expect(bodyText).toContain("Luis Mora");
  });

  it("protege POST /api/integrations/drive-files/report con X-Internal-Api-Key", async () => {
    const app = express();
    app.use(express.json());
    const reportDriveFileSync = {
      execute: vi.fn().mockResolvedValue({
        processedCount: 1,
        changedCount: 0,
        initializedCount: 1,
        alertsDispatched: 0,
        results: [],
      }),
    } as unknown as ReportDriveFileSyncUseCase;

    app.use(
      createDriveSyncIntegrationRouter({
        env: { API_INTERNAL_KEY: "secret-key-123" } as Env,
        reportDriveFileSync,
        logger: nullLogger,
      }),
    );

    const unauthorized = await request(app)
      .post("/api/integrations/drive-files/report")
      .send({ files: [] });
    expect(unauthorized.status).toBe(401);

    const authorized = await request(app)
      .post("/api/integrations/drive-files/report")
      .set("X-Internal-Api-Key", "secret-key-123")
      .send({
        files: [
          {
            fileName: "CARTERA",
            modifiedTime: "2026-11-25T14:00:00.000Z",
            modifiedBy: "Admin",
          },
        ],
      });
    expect(authorized.status).toBe(200);
    expect(authorized.body.success).toBe(true);
    expect(reportDriveFileSync.execute).toHaveBeenCalledTimes(1);
  });

  it("preserva cooldown en almacén persistente entre reinicios de instancia y lo limpia con clearAsync", async () => {
    const backedKeys = new Set<string>();
    const storeCallbacks = {
      tryAcquire: async (key: string) => {
        if (backedKeys.has(key)) return false;
        backedKeys.add(key);
        return true;
      },
      release: async (key: string) => {
        backedKeys.delete(key);
      },
    };

    const instance1 = new AlertCooldownCacheService(30 * 60 * 1000, storeCallbacks);
    expect(await instance1.shouldAlertAsync("sla:case:case-1")).toBe(true);

    // Simula un reinicio del servidor con nueva instancia en memoria pero mismo Redis
    const instance2 = new AlertCooldownCacheService(30 * 60 * 1000, storeCallbacks);
    expect(await instance2.shouldAlertAsync("sla:case:case-1")).toBe(false);

    await instance2.clearAsync("sla:case:case-1");
    expect(await instance2.shouldAlertAsync("sla:case:case-1")).toBe(true);
  });
});
