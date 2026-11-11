import { describe, expect, it, vi } from "vitest";
import { AnswerTelegramCopilotQuestionUseCase } from "../../src/core/modules/telegram/application/use-cases/answer-telegram-copilot-question.use-case";
import type { TelegramAiCopilotPort } from "../../src/core/modules/telegram/application/ports/telegram-ai-copilot.port";
import type { TelegramGatewayPort } from "../../src/core/modules/telegram/application/ports/telegram-gateway.port";
import type { CaseRepositoryPort } from "../../src/core/modules/cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../src/core/modules/departments/application/ports/agent.repository.port";
import type { AnalyticsRepositoryPort } from "../../src/core/modules/analytics/application/ports/analytics.repository.port";
import type { TelegramSettings } from "../../src/core/modules/telegram/domain/telegram-config.entity";
import type { SendTelegramMessageInput } from "../../src/core/modules/telegram/domain/telegram-message.types";
import { silentLogger } from "../support/silent-logger";

describe("AnswerTelegramCopilotQuestionUseCase", () => {
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
    webhookSecret: "secret-token",
    commandsEnabled: true,
    aiCopilotEnabled: true,
  };

  const createHarness = (settingsOverrides?: Partial<TelegramSettings>) => {
    const sentMessages: SendTelegramMessageInput[] = [];

    const fakeCopilotPort: TelegramAiCopilotPort = {
      classifyQuestion: vi.fn().mockResolvedValue({
        intent: "METRICS_OVERVIEW",
        confidence: 0.9,
      }),
      synthesizeReply: vi.fn().mockImplementation(async (input) => {
        return `🤖 <b>Síntesis de IA:</b>\n${input.groundTruth}`;
      }),
    };

    const fakeGateway = {
      getMe: vi.fn(),
      sendMessage: vi.fn().mockImplementation(async (msg: SendTelegramMessageInput) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 301, chatId: msg.chatId || "-100111", date: Date.now() };
      }),
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      setWebhook: vi.fn().mockResolvedValue(true),
    } as unknown as TelegramGatewayPort;

    const fakeCaseRepo = {
      findUnattendedHumanCases: vi.fn().mockResolvedValue([
        {
          caseId: "c-100",
          customerName: "Juan Pérez",
          customerPhone: "+593987654321",
          assignedAgentName: "Carlos Agente",
          departmentName: "Soporte",
          waitMinutes: 24,
        },
      ]),
    } as unknown as CaseRepositoryPort;

    const fakeAgentRepo = {
      list: vi.fn().mockResolvedValue([
        { id: "a1", name: "Carlos Agente", role: "agent", active: true, autoAssignEnabled: true },
        { id: "a2", name: "Lucía Agente", role: "agent", active: true, autoAssignEnabled: false },
      ]),
    } as unknown as AgentRepositoryPort;

    const fakeAnalyticsRepo = {
      getOverview: vi.fn().mockResolvedValue({
        totalCases: 55,
        completedCases: 40,
        activeCases: 15,
        botContainmentRate: 72,
        escalationRate: 28,
        avgQueueWaitTimeSeconds: 50,
      }),
      getInfrastructureAlerts: vi.fn().mockResolvedValue([
        {
          sector: "El Vecino",
          oltName: "OLT-SUR-01",
          activeCasesCount: 4,
          isHighVolumeAlert: true,
        },
      ]),
    } as unknown as AnalyticsRepositoryPort;

    const useCase = new AnswerTelegramCopilotQuestionUseCase({
      copilotPort: fakeCopilotPort,
      gateway: fakeGateway,
      caseRepo: fakeCaseRepo,
      agentRepo: fakeAgentRepo,
      analyticsRepo: fakeAnalyticsRepo,
      getSettings: async () => ({ ...baseSettings, ...(settingsOverrides || {}) }),
      appPublicUrl: "https://isp.example.com",
      logger: silentLogger,
    });

    return {
      useCase,
      sentMessages,
      fakeCopilotPort,
      fakeGateway,
      fakeCaseRepo,
      fakeAgentRepo,
      fakeAnalyticsRepo,
    };
  };

  it("omite la ejecución si aiCopilotEnabled está deshabilitado", async () => {
    const { useCase, fakeGateway } = createHarness({ aiCopilotEnabled: false });

    const result = await useCase.execute({
      question: "¿Cómo venimos hoy?",
      chatId: "-100111",
    });

    expect(result).toBeNull();
    expect(fakeGateway.sendMessage).not.toHaveBeenCalled();
  });

  it("responde consultas de métricas globales usando datos reales", async () => {
    const { useCase, sentMessages, fakeCopilotPort, fakeAnalyticsRepo } = createHarness();

    const result = await useCase.execute({
      question: "¿Cómo va la contención de IA y los casos hoy?",
      chatId: "-100111",
    });

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(fakeCopilotPort.classifyQuestion).toHaveBeenCalledWith("¿Cómo va la contención de IA y los casos hoy?");
    expect(fakeAnalyticsRepo.getOverview).toHaveBeenCalled();

    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0]!;
    expect(msg.chatId).toBe("-100111");
    expect(msg.text).toContain("Total casos hoy: 55");
    expect(msg.text).toContain("Tasa de contención de IA (resuelto sin humano): 72%");
  });

  it("responde consultas de demoras y brechas de SLA", async () => {
    const { useCase, sentMessages, fakeCopilotPort, fakeCaseRepo } = createHarness();

    fakeCopilotPort.classifyQuestion = vi.fn().mockResolvedValue({
      intent: "SLA_BREACHES",
      minWaitMinutes: 20,
      confidence: 0.95,
    });

    const result = await useCase.execute({
      question: "¿Tenemos clientes con más de 20 minutos de espera?",
      chatId: "-100111",
    });

    expect(result?.ok).toBe(true);
    expect(fakeCaseRepo.findUnattendedHumanCases).toHaveBeenCalledWith(20, 10);
    const msg = sentMessages[0]!;
    expect(msg.text).toContain("Juan Pérez");
    expect(msg.text).toContain("24 min");
  });

  it("responde consultas de personal en turno", async () => {
    const { useCase, sentMessages, fakeCopilotPort, fakeAgentRepo } = createHarness();

    fakeCopilotPort.classifyQuestion = vi.fn().mockResolvedValue({
      intent: "AGENTS_STATUS",
      confidence: 0.9,
    });

    const result = await useCase.execute({
      question: "¿Quiénes están en turno ahora?",
      chatId: "-100111",
    });

    expect(result?.ok).toBe(true);
    expect(fakeAgentRepo.list).toHaveBeenCalled();
    const msg = sentMessages[0]!;
    expect(msg.text).toContain("Total asesores activos en el turno: 2");
    expect(msg.text).toContain("Carlos Agente");
  });

  it("responde consultas de infraestructura filtrando por sector", async () => {
    const { useCase, sentMessages, fakeCopilotPort, fakeAnalyticsRepo } = createHarness();

    fakeCopilotPort.classifyQuestion = vi.fn().mockResolvedValue({
      intent: "INFRA_ALERTS",
      sector: "El Vecino",
      confidence: 0.88,
    });

    const result = await useCase.execute({
      question: "¿Hay alguna falla en El Vecino?",
      chatId: "-100111",
    });

    expect(result?.ok).toBe(true);
    expect(fakeAnalyticsRepo.getInfrastructureAlerts).toHaveBeenCalled();
    const msg = sentMessages[0]!;
    expect(msg.text).toContain("Sector: El Vecino");
    expect(msg.text).toContain("OLT-SUR-01");
  });

  it("incluye desglose de ventas, departamentos, carga en vivo y tendencia de 7 días en METRICS_OVERVIEW", async () => {
    const { useCase, sentMessages, fakeCaseRepo, fakeAnalyticsRepo } = createHarness();

    (fakeCaseRepo as any).getDashboardMetrics = vi.fn().mockResolvedValue({
      myAssignedCases: 5,
      escalatedPending: 3,
      waitingUser: 1,
      resolvedToday: 0,
      departmentBreakdown: [
        { departmentId: "d-ventas", departmentName: "Ventas", activeCases: 2, queueCases: 1 },
        { departmentId: "d-soporte", departmentName: "Soporte tecnico", activeCases: 2, queueCases: 1 },
      ],
    });

    (fakeAnalyticsRepo as any).getCasesDistribution = vi
      .fn()
      .mockResolvedValueOnce({
        totalCases: 2,
        byWorkflow: [{ workflowType: "SALES", count: 2, percentage: 100 }],
        byFinalStatus: [{ status: "COMPLETED", count: 2, percentage: 100 }],
        topEscalationReasons: [],
        byDepartment: [{ departmentId: "d-ventas", departmentName: "Ventas", count: 2, percentage: 100 }],
      })
      .mockResolvedValueOnce({
        totalCases: 8,
        byWorkflow: [{ workflowType: "SALES", count: 4, percentage: 50 }],
        byFinalStatus: [],
        topEscalationReasons: [],
        byDepartment: [{ departmentId: "d-ventas", departmentName: "Ventas", count: 4, percentage: 50 }],
      });

    (fakeAnalyticsRepo as any).getAIEfficiency = vi.fn().mockResolvedValue({
      overallContainmentRate: 75,
      botCompletedCases: 3,
      humanEscalatedCases: 1,
      funnelDropOff: [],
      unclearTriageCount: 0,
    });

    (fakeAnalyticsRepo as any).getAgentsPerformance = vi.fn().mockResolvedValue([
      {
        agentId: "a1",
        agentName: "Carlos Agente",
        primaryDepartmentId: "d-ventas",
        primaryDepartmentName: "Ventas",
        role: "agent",
        autoAssignEnabled: true,
        activeCasesNow: 2,
        maxCapacityThreshold: 5,
        casesAssigned: 3,
        casesCompleted: 2,
        casesTransferred: 0,
        avgFirstResponseTimeMs: 12000,
        avgHandlingTimeMinutes: 8,
        fcrRatePercentage: 90,
        avgCordialityScore: 95,
        criticalAlertsCount: 0,
        openCoachingNotesCount: 0,
      },
    ]);

    const result = await useCase.execute({
      question: "¿Cuántas ventas tuvimos hoy?",
      chatId: "-100111",
    });

    expect(result?.ok).toBe(true);
    const msg = sentMessages[0]!;
    expect(msg.text).toContain("Ventas y Planes Nuevos [SALES] (2)");
    expect(msg.text).toContain("Ventas: 2 activos | 1 en cola");
    expect(msg.text).toContain("FCR promedio: 90% | Cordialidad media: 95/100");
    expect(msg.text).toContain("Total casos ingresados últimos 7 días: 8");
  });

  it("enriquece AGENTS_STATUS con carga actual y calidad cuando getAgentsPerformance está disponible", async () => {
    const { useCase, sentMessages, fakeCopilotPort, fakeAnalyticsRepo } = createHarness();

    fakeCopilotPort.classifyQuestion = vi.fn().mockResolvedValue({
      intent: "AGENTS_STATUS",
      confidence: 0.94,
    });

    (fakeAnalyticsRepo as any).getAgentsPerformance = vi.fn().mockResolvedValue([
      {
        agentId: "a1",
        agentName: "Carlos Agente",
        primaryDepartmentId: "d-soporte",
        primaryDepartmentName: "Soporte tecnico",
        role: "agent",
        autoAssignEnabled: true,
        activeCasesNow: 3,
        maxCapacityThreshold: 5,
        casesAssigned: 4,
        casesCompleted: 2,
        casesTransferred: 0,
        avgFirstResponseTimeMs: 15000,
        avgHandlingTimeMinutes: 10,
        fcrRatePercentage: 88,
        avgCordialityScore: 92,
        criticalAlertsCount: 0,
        openCoachingNotesCount: 0,
        unattendedActiveCases: 1,
      },
    ]);

    const result = await useCase.execute({
      question: "¿Quiénes están en turno y con cuánta carga?",
      chatId: "-100111",
    });

    expect(result?.ok).toBe(true);
    const msg = sentMessages[0]!;
    expect(msg.text).toContain("activos ahora: 3/5");
    expect(msg.text).toContain("resueltos hoy: 2");
    expect(msg.text).toContain("FCR: 88%");
  });
});

