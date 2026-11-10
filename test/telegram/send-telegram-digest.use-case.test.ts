import { describe, expect, it, vi } from "vitest";
import { SendTelegramDigestUseCase } from "../../src/core/modules/telegram/application/use-cases/send-telegram-digest.use-case";
import type { AnalyticsRepositoryPort } from "../../src/core/modules/analytics/application/ports/analytics.repository.port";
import type { CaseRepositoryPort } from "../../src/core/modules/cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../src/core/modules/departments/application/ports/agent.repository.port";
import type { TelegramSettings } from "../../src/core/modules/telegram/domain/telegram-config.entity";
import type { TelegramAlertPayload } from "../../src/core/modules/telegram/domain/telegram-message.types";
import { silentLogger } from "../support/silent-logger";

describe("SendTelegramDigestUseCase", () => {
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

  it("omite el envío si digestsEnabled está en false y no es forzado", async () => {
    const fakeAnalyticsRepo = { getOverview: vi.fn() } as unknown as AnalyticsRepositoryPort;
    const fakeCaseRepo = { getDashboardMetrics: vi.fn() } as unknown as CaseRepositoryPort;
    const fakeAgentRepo = { list: vi.fn() } as unknown as AgentRepositoryPort;
    const fakeSender = { execute: vi.fn() } as any;

    const useCase = new SendTelegramDigestUseCase({
      analyticsRepo: fakeAnalyticsRepo,
      caseRepo: fakeCaseRepo,
      agentRepo: fakeAgentRepo,
      sendTelegramAlert: fakeSender,
      getSettings: async () => ({ ...baseSettings, digestsEnabled: false }),
      appPublicUrl: "https://isp.example.com",
      logger: silentLogger,
    });

    const result = await useCase.execute({ forced: false });
    expect(result).toBeNull();
    expect(fakeSender.execute).not.toHaveBeenCalled();
    expect(fakeAnalyticsRepo.getOverview).not.toHaveBeenCalled();
  });

  it("compila métricas del día y envía el digest en HTML con enlaces y desglose departamental", async () => {
    let sentPayload: TelegramAlertPayload | undefined;
    const fakeSender = {
      execute: vi.fn().mockImplementation(async (payload: TelegramAlertPayload) => {
        sentPayload = payload;
        return { ok: true, messageId: 999 };
      }),
    } as any;

    const fakeAnalyticsRepo = {
      getOverview: vi.fn().mockResolvedValue({
        totalCases: 42,
        activeCases: 8,
        completedCases: 34,
        botContainmentRate: 75.5,
        avgResolutionTimeMinutes: 12.4,
        avgQueueWaitTimeSeconds: 45,
        escalationRate: 24.5,
      }),
    } as unknown as AnalyticsRepositoryPort;

    const fakeCaseRepo = {
      getDashboardMetrics: vi.fn().mockResolvedValue({
        myAssignedCases: 8,
        escalatedPending: 2,
        waitingUser: 3,
        botActiveCases: 15,
        departmentBreakdown: [
          {
            departmentId: "dept-1",
            departmentName: "Soporte Técnico",
            activeCases: 5,
            queueCases: 2,
          },
          {
            departmentId: "dept-2",
            departmentName: "Ventas",
            activeCases: 3,
            queueCases: 0,
          },
        ],
      }),
    } as unknown as CaseRepositoryPort;

    const fakeAgentRepo = {
      list: vi.fn().mockResolvedValue([
        { id: "a1", name: "Agente 1", active: true, autoAssignEnabled: true },
        { id: "a2", name: "Agente 2", active: true, autoAssignEnabled: false },
        { id: "a3", name: "Agente 3", active: false, autoAssignEnabled: true },
      ]),
    } as unknown as AgentRepositoryPort;

    const useCase = new SendTelegramDigestUseCase({
      analyticsRepo: fakeAnalyticsRepo,
      caseRepo: fakeCaseRepo,
      agentRepo: fakeAgentRepo,
      sendTelegramAlert: fakeSender,
      getSettings: async () => baseSettings,
      appPublicUrl: "https://isp.example.com",
      logger: silentLogger,
    });

    const result = await useCase.execute({ timeLabel: "14:00" });

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(fakeSender.execute).toHaveBeenCalledTimes(1);

    expect(sentPayload).toBeDefined();
    const payload = sentPayload as TelegramAlertPayload;
    expect(payload.category).toBe("DIGEST");
    expect(payload.severity).toBe("INFO");
    expect(payload.body).toContain("PULSO OPERATIVO EJECUTIVO - 14:00");
    expect(payload.body).toContain("Casos Registrados:</b> <code>42</code>");
    expect(payload.body).toContain("Casos Resueltos:</b> <code>34</code>");
    expect(payload.body).toContain("Contención de IA:</b> <code>76%</code>");
    expect(payload.body).toContain("Derivación Humana:</b> <code>25%</code>");
    expect(payload.body).toContain("Espera media en cola:</b> <code>45 seg</code>");
    expect(payload.body).toContain("Tiempo medio de resolución:</b> <code>12.4 min</code>");
    expect(payload.body).toContain("Asesores en turno disponibles:</b> <code>1</code>");
    expect(payload.body).toContain("Soporte Técnico:</b> <code>5 activos | 2 en cola</code>");
    expect(payload.body).toContain("Ventas:</b> <code>3 activos | 0 en cola</code>");
    expect(payload.actions?.[0]?.url).toBe("https://isp.example.com/analitica");
  });

  it("tolera fallas en repositorios auxiliares y emite el digest con valores por defecto", async () => {
    let sentPayload: TelegramAlertPayload | undefined;
    const fakeSender = {
      execute: vi.fn().mockImplementation(async (payload: TelegramAlertPayload) => {
        sentPayload = payload;
        return { ok: true, messageId: 1000 };
      }),
    } as any;

    const fakeAnalyticsRepo = {
      getOverview: vi.fn().mockRejectedValue(new Error("DB connection timeout")),
    } as unknown as AnalyticsRepositoryPort;

    const fakeCaseRepo = {
      getDashboardMetrics: vi.fn().mockRejectedValue(new Error("Query failed")),
    } as unknown as CaseRepositoryPort;

    const fakeAgentRepo = {
      list: vi.fn().mockRejectedValue(new Error("Agent repo error")),
    } as unknown as AgentRepositoryPort;

    const useCase = new SendTelegramDigestUseCase({
      analyticsRepo: fakeAnalyticsRepo,
      caseRepo: fakeCaseRepo,
      agentRepo: fakeAgentRepo,
      sendTelegramAlert: fakeSender,
      getSettings: async () => baseSettings,
      appPublicUrl: "https://isp.example.com",
      logger: silentLogger,
    });

    const result = await useCase.execute();

    expect(result?.ok).toBe(true);
    const payload = sentPayload as TelegramAlertPayload;
    expect(payload.body).toContain("Casos Registrados:</b> <code>0</code>");
    expect(payload.body).toContain("Contención de IA:</b> <code>0%</code>");
  });

  it("fuerza el envío si forced: true aunque digestsEnabled esté deshabilitado", async () => {
    const fakeSender = {
      execute: vi.fn().mockResolvedValue({ ok: true, messageId: 1001 }),
    } as any;

    const useCase = new SendTelegramDigestUseCase({
      analyticsRepo: { getOverview: vi.fn().mockResolvedValue({}) } as any,
      caseRepo: { getDashboardMetrics: vi.fn().mockResolvedValue({}) } as any,
      agentRepo: { list: vi.fn().mockResolvedValue([]) } as any,
      sendTelegramAlert: fakeSender,
      getSettings: async () => ({ ...baseSettings, digestsEnabled: false }),
      appPublicUrl: "https://isp.example.com",
      logger: silentLogger,
    });

    const result = await useCase.execute({ forced: true });
    expect(result?.ok).toBe(true);
    expect(fakeSender.execute).toHaveBeenCalledTimes(1);
  });
});
