import { describe, expect, it, vi } from "vitest";
import { CheckSystemAlertsUseCase } from "../../src/core/modules/telegram/application/use-cases/check-system-alerts.use-case";
import { AlertCooldownCacheService } from "../../src/core/modules/telegram/application/services/alert-cooldown-cache.service";
import type { CaseRepositoryPort, UnattendedHumanCaseItem } from "../../src/core/modules/cases/application/ports/case.repository.port";
import type { EscalationRepositoryPort, PendingDelayedEscalationItem } from "../../src/core/modules/escalation/application/ports/escalation.repository.port";
import type { AnalyticsRepositoryPort } from "../../src/core/modules/analytics/application/ports/analytics.repository.port";
import type { TelegramSettings } from "../../src/core/modules/telegram/domain/telegram-config.entity";
import type { TelegramAlertPayload } from "../../src/core/modules/telegram/domain/telegram-message.types";
import { silentLogger } from "../support/silent-logger";

describe("CheckSystemAlertsUseCase", () => {
  const baseSettings: TelegramSettings = {
    enabled: true,
    botToken: "123:ABC",
    defaultChatId: "-100111",
    topicsEnabled: false,
    topics: [],
    slaTopicId: 10,
    infraTopicId: 20,
    digestsTopicId: 30,
    digestsEnabled: true,
    digestHours: ["09:00", "14:00", "19:00"],
    timeZone: "America/Guayaquil",
    alertRules: [],
    slaThresholdMinutes: 15,
    infraAlertMinCases: 3,
    queueSaturationThreshold: 10,
    webhookSecret: "",
    commandsEnabled: true,
    aiCopilotEnabled: false,
  };

  it("omite la evaluación si Telegram está deshabilitado", async () => {
    const fakeCaseRepo = { findUnattendedHumanCases: vi.fn() } as unknown as CaseRepositoryPort;
    const fakeEscalationRepo = { findPendingDelayedEscalations: vi.fn() } as unknown as EscalationRepositoryPort;
    const fakeAnalyticsRepo = { getInfrastructureAlerts: vi.fn() } as unknown as AnalyticsRepositoryPort;
    const fakeSender = { execute: vi.fn() } as any;

    const useCase = new CheckSystemAlertsUseCase({
      caseRepo: fakeCaseRepo,
      escalationRepo: fakeEscalationRepo,
      analyticsRepo: fakeAnalyticsRepo,
      sendTelegramAlert: fakeSender,
      getSettings: async () => ({ ...baseSettings, enabled: false }),
      cooldownCache: new AlertCooldownCacheService(),
      appPublicUrl: "http://localhost:3000",
      logger: silentLogger,
    });

    const result = await useCase.execute();
    expect(result.dispatchedCount).toBe(0);
    expect(fakeCaseRepo.findUnattendedHumanCases).not.toHaveBeenCalled();
  });

  it("detecta y despacha alertas de SLA para casos humanos demorados respetando cooldown", async () => {
    const sentAlerts: TelegramAlertPayload[] = [];
    const unattendedCases: UnattendedHumanCaseItem[] = [
      {
        caseId: "case-101",
        conversationId: "conv-1",
        departmentId: "dept-1",
        departmentName: "Soporte Técnico",
        assignedAgentId: "agent-1",
        assignedAgentName: "Juan Agente",
        customerName: "María Pérez",
        customerPhone: "+593991234567",
        waitMinutes: 25,
      },
    ];

    const fakeCaseRepo = {
      findUnattendedHumanCases: vi.fn().mockResolvedValue(unattendedCases),
    } as unknown as CaseRepositoryPort;
    const fakeEscalationRepo = {
      findPendingDelayedEscalations: vi.fn().mockResolvedValue([]),
    } as unknown as EscalationRepositoryPort;
    const fakeAnalyticsRepo = {
      getInfrastructureAlerts: vi.fn().mockResolvedValue([]),
    } as unknown as AnalyticsRepositoryPort;

    const fakeSender = {
      execute: vi.fn().mockImplementation(async (alert: TelegramAlertPayload) => {
        sentAlerts.push(alert);
        return { ok: true, messageId: 1, chatId: "-100111", date: Date.now() };
      }),
    } as any;

    const cooldown = new AlertCooldownCacheService();

    const useCase = new CheckSystemAlertsUseCase({
      caseRepo: fakeCaseRepo,
      escalationRepo: fakeEscalationRepo,
      analyticsRepo: fakeAnalyticsRepo,
      sendTelegramAlert: fakeSender,
      getSettings: async () => baseSettings,
      cooldownCache: cooldown,
      appPublicUrl: "http://localhost:3000",
      logger: silentLogger,
    });

    // 1ra ejecución: Dispara alerta
    const result1 = await useCase.execute();
    expect(result1.dispatchedCount).toBe(1);
    expect(result1.slaBreachesCount).toBe(1);
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]?.category).toBe("SLA");
    expect(sentAlerts[0]?.severity).toBe("CRITICAL");
    expect(sentAlerts[0]?.body).toContain("María Pérez");
    expect(sentAlerts[0]?.body).toContain("25 minutos");

    // 2da ejecución inmediata: Debe entrar en cooldown y no re-disparar
    const result2 = await useCase.execute();
    expect(result2.dispatchedCount).toBe(0);
    expect(sentAlerts).toHaveLength(1);
  });

  it("detecta y despacha alertas de infraestructura ante concentración masiva de caídas", async () => {
    const sentAlerts: TelegramAlertPayload[] = [];
    const fakeCaseRepo = {
      findUnattendedHumanCases: vi.fn().mockResolvedValue([]),
    } as unknown as CaseRepositoryPort;
    const fakeEscalationRepo = {
      findPendingDelayedEscalations: vi.fn().mockResolvedValue([]),
    } as unknown as EscalationRepositoryPort;
    const fakeAnalyticsRepo = {
      getInfrastructureAlerts: vi.fn().mockResolvedValue([
        {
          sector: "Totoracocha",
          oltName: "OLT-Sur-01",
          activeCasesCount: 5,
          isHighVolumeAlert: true,
        },
      ]),
    } as unknown as AnalyticsRepositoryPort;

    const fakeSender = {
      execute: vi.fn().mockImplementation(async (alert: TelegramAlertPayload) => {
        sentAlerts.push(alert);
        return { ok: true, messageId: 2, chatId: "-100111", date: Date.now() };
      }),
    } as any;

    const useCase = new CheckSystemAlertsUseCase({
      caseRepo: fakeCaseRepo,
      escalationRepo: fakeEscalationRepo,
      analyticsRepo: fakeAnalyticsRepo,
      sendTelegramAlert: fakeSender,
      getSettings: async () => baseSettings,
      cooldownCache: new AlertCooldownCacheService(),
      appPublicUrl: "http://localhost:3000",
      logger: silentLogger,
    });

    const result = await useCase.execute();
    expect(result.dispatchedCount).toBe(1);
    expect(result.infraAlertsCount).toBe(1);
    expect(sentAlerts[0]?.category).toBe("INFRASTRUCTURE");
    expect(sentAlerts[0]?.title).toContain("Totoracocha");
    expect(sentAlerts[0]?.body).toContain("5 reportes");
  });

  it("detecta clientes demorados en cola de espera (escalations PENDING)", async () => {
    const sentAlerts: TelegramAlertPayload[] = [];
    const pendingQueue: PendingDelayedEscalationItem[] = [
      {
        escalationId: "esc-1",
        caseId: "case-200",
        departmentId: "dept-2",
        departmentName: "Facturación",
        customerName: "Carlos Gómez",
        customerPhone: "+593987654321",
        priority: "high",
        waitMinutes: 18,
      },
    ];

    const fakeCaseRepo = {
      findUnattendedHumanCases: vi.fn().mockResolvedValue([]),
    } as unknown as CaseRepositoryPort;
    const fakeEscalationRepo = {
      findPendingDelayedEscalations: vi.fn().mockResolvedValue(pendingQueue),
    } as unknown as EscalationRepositoryPort;
    const fakeAnalyticsRepo = {
      getInfrastructureAlerts: vi.fn().mockResolvedValue([]),
    } as unknown as AnalyticsRepositoryPort;

    const fakeSender = {
      execute: vi.fn().mockImplementation(async (alert: TelegramAlertPayload) => {
        sentAlerts.push(alert);
        return { ok: true, messageId: 3, chatId: "-100111", date: Date.now() };
      }),
    } as any;

    const useCase = new CheckSystemAlertsUseCase({
      caseRepo: fakeCaseRepo,
      escalationRepo: fakeEscalationRepo,
      analyticsRepo: fakeAnalyticsRepo,
      sendTelegramAlert: fakeSender,
      getSettings: async () => baseSettings,
      cooldownCache: new AlertCooldownCacheService(),
      appPublicUrl: "http://localhost:3000",
      logger: silentLogger,
    });

    const result = await useCase.execute();
    expect(result.dispatchedCount).toBe(1);
    expect(result.queueDelaysCount).toBe(1);
    expect(sentAlerts[0]?.category).toBe("QUEUE");
    expect(sentAlerts[0]?.title).toContain("Cliente en cola de espera");
    expect(sentAlerts[0]?.body).toContain("Carlos Gómez");
  });

  it("respeta las reglas dinámicas del Centinela (omitiendo alertas si la regla está deshabilitada)", async () => {
    const fakeCaseRepo = {
      findUnattendedHumanCases: vi.fn(),
    } as unknown as CaseRepositoryPort;
    const fakeEscalationRepo = {
      findPendingDelayedEscalations: vi.fn(),
    } as unknown as EscalationRepositoryPort;
    const fakeAnalyticsRepo = {
      getInfrastructureAlerts: vi.fn(),
    } as unknown as AnalyticsRepositoryPort;
    const fakeSender = { execute: vi.fn() } as any;

    const useCase = new CheckSystemAlertsUseCase({
      caseRepo: fakeCaseRepo,
      escalationRepo: fakeEscalationRepo,
      analyticsRepo: fakeAnalyticsRepo,
      sendTelegramAlert: fakeSender,
      getSettings: async () => ({
        ...baseSettings,
        alertRules: [
          {
            id: "rule-sla-delay",
            name: "SLA Silenciado",
            category: "SLA",
            threshold: 15,
            unit: "min",
            severity: "CRITICAL",
            enabled: false, // Deshabilitada por el admin
            description: "",
          },
        ],
      }),
      cooldownCache: new AlertCooldownCacheService(),
      appPublicUrl: "http://localhost:3000",
      logger: silentLogger,
    });

    const result = await useCase.execute();
    expect(result.dispatchedCount).toBe(0);
    // Como la regla SLA estaba en enabled: false, ni siquiera consulta casos desatendidos
    expect(fakeCaseRepo.findUnattendedHumanCases).not.toHaveBeenCalled();
  });
});
