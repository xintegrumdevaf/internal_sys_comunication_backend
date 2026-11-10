import { describe, expect, it, vi } from "vitest";
import { HandleTelegramWebhookUseCase } from "../../src/core/modules/telegram/application/use-cases/handle-telegram-webhook.use-case";
import type { TelegramGatewayPort } from "../../src/core/modules/telegram/application/ports/telegram-gateway.port";
import type { CaseRepositoryPort } from "../../src/core/modules/cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../src/core/modules/departments/application/ports/agent.repository.port";
import type { AnalyticsRepositoryPort } from "../../src/core/modules/analytics/application/ports/analytics.repository.port";
import type { TelegramSettings } from "../../src/core/modules/telegram/domain/telegram-config.entity";
import type { SendTelegramMessageInput, TelegramUpdate } from "../../src/core/modules/telegram/domain/telegram-message.types";
import { silentLogger } from "../support/silent-logger";

describe("HandleTelegramWebhookUseCase", () => {
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
    webhookSecret: "super-secret-token",
    commandsEnabled: true,
    aiCopilotEnabled: true,
  };

  const createHarness = (overrides?: Partial<TelegramSettings>) => {
    const sentMessages: SendTelegramMessageInput[] = [];
    const answeredQueries: Array<{ callbackQueryId: string; text?: string }> = [];

    const fakeGateway = {
      getMe: vi.fn(),
      sendMessage: vi.fn().mockImplementation(async (msg: SendTelegramMessageInput) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 101, chatId: msg.chatId || "-100111", date: Date.now() };
      }),
      answerCallbackQuery: vi.fn().mockImplementation(async (input) => {
        answeredQueries.push(input);
        return true;
      }),
      setWebhook: vi.fn().mockResolvedValue(true),
    } as unknown as TelegramGatewayPort;

    const fakeCaseRepo = {
      findUnattendedHumanCases: vi.fn().mockResolvedValue([]),
    } as unknown as CaseRepositoryPort;

    const fakeAgentRepo = {
      list: vi.fn().mockResolvedValue([
        { id: "a1", name: "Carlos Asesor", role: "agent", active: true, autoAssignEnabled: true },
        { id: "a2", name: "Ana Asesora", role: "agent", active: true, autoAssignEnabled: false },
      ]),
    } as unknown as AgentRepositoryPort;

    const fakeAnalyticsRepo = {
      getInfrastructureAlerts: vi.fn().mockResolvedValue([]),
    } as unknown as AnalyticsRepositoryPort;

    const fakeSendDigest = {
      execute: vi.fn().mockResolvedValue({ ok: true, messageId: 202 }),
    } as any;

    const fakeCopilotUseCase = {
      execute: vi.fn().mockResolvedValue({ ok: true, messageId: 303 }),
    } as any;

    const useCase = new HandleTelegramWebhookUseCase({
      gateway: fakeGateway,
      getSettings: async () => ({ ...baseSettings, ...(overrides || {}) }),
      caseRepo: fakeCaseRepo,
      agentRepo: fakeAgentRepo,
      analyticsRepo: fakeAnalyticsRepo,
      sendTelegramDigest: fakeSendDigest,
      answerCopilotQuestion: fakeCopilotUseCase,
      appPublicUrl: "https://isp.example.com",
      logger: silentLogger,
    });

    return {
      useCase,
      sentMessages,
      answeredQueries,
      fakeGateway,
      fakeCaseRepo,
      fakeAgentRepo,
      fakeAnalyticsRepo,
      fakeSendDigest,
      fakeCopilotUseCase,
    };
  };

  it("omite la actualización si la integración o comandos están deshabilitados", async () => {
    const { useCase, fakeGateway } = createHarness({ commandsEnabled: false });

    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: -100111, type: "supergroup" },
        date: Date.now(),
        text: "/ayuda",
      },
    };

    const res = await useCase.execute({
      update,
      secretTokenHeader: "super-secret-token",
    });

    expect(res.handled).toBe(false);
    expect(res.reason).toBe("disabled");
    expect(fakeGateway.sendMessage).not.toHaveBeenCalled();
  });

  it("rechaza el webhook si el secretTokenHeader no coincide con el configurado", async () => {
    const { useCase, fakeGateway } = createHarness();

    const update: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 10,
        chat: { id: -100111, type: "supergroup" },
        date: Date.now(),
        text: "/resumen",
      },
    };

    const res = await useCase.execute({
      update,
      secretTokenHeader: "clave-incorrecta",
    });

    expect(res.handled).toBe(false);
    expect(res.reason).toBe("invalid_secret");
    expect(fakeGateway.sendMessage).not.toHaveBeenCalled();
  });

  it("rechaza mensajes que provengan de un chatId no autorizado", async () => {
    const { useCase, fakeGateway } = createHarness();

    const update: TelegramUpdate = {
      update_id: 3,
      message: {
        message_id: 10,
        chat: { id: -999999, type: "supergroup" }, // diferente a -100111
        date: Date.now(),
        text: "/sla",
      },
    };

    const res = await useCase.execute({
      update,
      secretTokenHeader: "super-secret-token",
    });

    expect(res.handled).toBe(false);
    expect(res.reason).toBe("unauthorized_chat");
    expect(fakeGateway.sendMessage).not.toHaveBeenCalled();
  });

  it("ejecuta el comando /resumen disparando sendTelegramDigest", async () => {
    const { useCase, fakeSendDigest } = createHarness();

    const update: TelegramUpdate = {
      update_id: 4,
      message: {
        message_id: 10,
        chat: { id: -100111, type: "supergroup" },
        date: Date.now(),
        text: "/resumen@ISPOpsBot",
      },
    };

    const res = await useCase.execute({
      update,
      secretTokenHeader: "super-secret-token",
    });

    expect(res.handled).toBe(true);
    expect(res.command).toBe("resumen");
    expect(fakeSendDigest.execute).toHaveBeenCalledWith({
      forced: true,
      timeLabel: "Solicitado en Chat",
    });
  });

  it("ejecuta el comando /sla reportando brechas cuando existen casos demorados", async () => {
    const { useCase, sentMessages, fakeCaseRepo } = createHarness();

    (fakeCaseRepo.findUnattendedHumanCases as any).mockResolvedValue([
      {
        caseId: "c-1",
        customerName: "Mario Benedetti",
        customerPhone: "+593998877665",
        assignedAgentName: "Carlos Asesor",
        departmentName: "Soporte Técnico",
        waitMinutes: 28,
      },
    ]);

    const update: TelegramUpdate = {
      update_id: 5,
      message: {
        message_id: 10,
        chat: { id: -100111, type: "supergroup" },
        date: Date.now(),
        text: "/sla",
      },
    };

    const res = await useCase.execute({
      update,
      secretTokenHeader: "super-secret-token",
    });

    expect(res.handled).toBe(true);
    expect(res.command).toBe("sla");
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0]!;
    expect(msg.text).toContain("BRECHAS DE SLA EN ATENCIÓN HUMANA");
    expect(msg.text).toContain("Mario Benedetti");
    expect(msg.text).toContain("28 min en espera");
    expect(msg.text).toContain("Carlos Asesor");
  });

  it("ejecuta el comando /agentes listando el personal en turno y su disponibilidad", async () => {
    const { useCase, sentMessages } = createHarness();

    const update: TelegramUpdate = {
      update_id: 6,
      message: {
        message_id: 10,
        chat: { id: -100111, type: "supergroup" },
        date: Date.now(),
        text: "/agentes",
      },
    };

    const res = await useCase.execute({
      update,
      secretTokenHeader: "super-secret-token",
    });

    expect(res.handled).toBe(true);
    expect(res.command).toBe("agentes");
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0]!;
    expect(msg.text).toContain("ESTADO DE ASESORES EN TURNO");
    expect(msg.text).toContain("Carlos Asesor");
    expect(msg.text).toContain("🟢 Asignación activa");
    expect(msg.text).toContain("Ana Asesora");
    expect(msg.text).toContain("🟡 Asignación pausada");
  });

  it("ejecuta el comando /infra reportando estado de red", async () => {
    const { useCase, sentMessages, fakeAnalyticsRepo } = createHarness();

    (fakeAnalyticsRepo.getInfrastructureAlerts as any).mockResolvedValue([
      {
        sector: "Ricaurte Central",
        oltName: "OLT-NORTE-01",
        activeCasesCount: 5,
        isHighVolumeAlert: true,
      },
    ]);

    const update: TelegramUpdate = {
      update_id: 7,
      message: {
        message_id: 10,
        chat: { id: -100111, type: "supergroup" },
        date: Date.now(),
        text: "/infra",
      },
    };

    const res = await useCase.execute({
      update,
      secretTokenHeader: "super-secret-token",
    });

    expect(res.handled).toBe(true);
    expect(res.command).toBe("infra");
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0]!;
    expect(msg.text).toContain("ALERTAS DE INFRAESTRUCTURA / RED");
    expect(msg.text).toContain("Ricaurte Central");
    expect(msg.text).toContain("OLT-NORTE-01");
    expect(msg.text).toContain("Corte Masivo Probable");
  });

  it("procesa callback_query respondiendo el spinner y despachando el comando", async () => {
    const { useCase, answeredQueries, fakeSendDigest } = createHarness();

    const update: TelegramUpdate = {
      update_id: 8,
      callback_query: {
        id: "cq-999",
        from: { id: 111, is_bot: false, first_name: "Gerente" },
        message: {
          message_id: 20,
          chat: { id: -100111, type: "supergroup" },
          date: Date.now(),
        },
        data: "cmd:resumen",
      },
    };

    const res = await useCase.execute({
      update,
      secretTokenHeader: "super-secret-token",
    });

    expect(res.handled).toBe(true);
    expect(res.command).toBe("resumen");
    expect(answeredQueries).toHaveLength(1);
    const query = answeredQueries[0]!;
    expect(query.callbackQueryId).toBe("cq-999");
    expect(fakeSendDigest.execute).toHaveBeenCalled();
  });

  it("delega preguntas en lenguaje natural al Copilot de IA si no es un comando con '/'", async () => {
    const { useCase, fakeCopilotUseCase } = createHarness();

    const update: TelegramUpdate = {
      update_id: 9,
      message: {
        message_id: 25,
        chat: { id: -100111, type: "supergroup" },
        date: Date.now(),
        text: "¿Cómo vienen los tiempos de atención hoy?",
      },
    };

    const res = await useCase.execute({
      update,
      secretTokenHeader: "super-secret-token",
    });

    expect(res.handled).toBe(true);
    expect(res.command).toBe("ai_copilot");
    expect(fakeCopilotUseCase.execute).toHaveBeenCalledWith({
      question: "¿Cómo vienen los tiempos de atención hoy?",
      chatId: "-100111",
      messageThreadId: undefined,
    });
  });
});
