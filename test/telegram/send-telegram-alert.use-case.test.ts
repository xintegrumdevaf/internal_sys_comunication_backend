import { describe, expect, it, vi } from "vitest";
import { SendTelegramAlertUseCase } from "../../src/core/modules/telegram/application/use-cases/send-telegram-alert.use-case";
import type { TelegramGatewayPort } from "../../src/core/modules/telegram/application/ports/telegram-gateway.port";
import type { TelegramSettings } from "../../src/core/modules/telegram/domain/telegram-config.entity";
import { silentLogger } from "../support/silent-logger";

describe("SendTelegramAlertUseCase", () => {
  const baseSettings: TelegramSettings = {
    enabled: true,
    botToken: "123:ABC",
    defaultChatId: "-100111",
    slaTopicId: 10,
    infraTopicId: 20,
    digestsTopicId: 30,
    digestsEnabled: true,
    digestHours: ["09:00", "14:00", "19:00"],
    timeZone: "America/Guayaquil",
    slaThresholdMinutes: 15,
    infraAlertMinCases: 3,
    queueSaturationThreshold: 10,
  };

  it("omite el envío silenciosamente si el módulo de Telegram está deshabilitado", async () => {
    const fakeGateway: TelegramGatewayPort = {
      getMe: vi.fn(),
      sendMessage: vi.fn(),
    };

    const useCase = new SendTelegramAlertUseCase({
      gateway: fakeGateway,
      getSettings: async () => ({ ...baseSettings, enabled: false }),
      logger: silentLogger,
    });

    const res = await useCase.execute({
      category: "SLA",
      severity: "CRITICAL",
      title: "Demora excesiva",
      body: "Cliente esperando",
    });

    expect(res).toBeNull();
    expect(fakeGateway.sendMessage).not.toHaveBeenCalled();
  });

  it("enruta alertas de SLA al topic configurado y formatea con prefijo [CRÍTICO]", async () => {
    let capturedInput: any = null;
    const fakeGateway: TelegramGatewayPort = {
      getMe: vi.fn(),
      sendMessage: vi.fn().mockImplementation(async (input) => {
        capturedInput = input;
        return { ok: true, messageId: 55, chatId: input.chatId, date: Date.now() };
      }),
    };

    const useCase = new SendTelegramAlertUseCase({
      gateway: fakeGateway,
      getSettings: async () => baseSettings,
      logger: silentLogger,
    });

    const res = await useCase.execute({
      category: "SLA",
      severity: "CRITICAL",
      title: "Caso demorado sin atención",
      body: "El cliente Juan Pérez lleva 22 minutos esperando respuesta del asesor.",
      metadata: {
        Asesor: "Carlos López",
        Departamento: "Soporte",
        Espera: "22 min",
      },
      actions: [{ label: "Ver en Panel", url: "https://isp.local/cases/abc" }],
    });

    expect(res).not.toBeNull();
    expect(res?.messageId).toBe(55);
    expect(capturedInput.messageThreadId).toBe(10); // slaTopicId
    expect(capturedInput.chatId).toBe("-100111");
    expect(capturedInput.text).toContain("🚨 <b>[CRÍTICO]</b> <b>Caso demorado sin atención</b>");
    expect(capturedInput.text).toContain("• <b>Asesor:</b> <code>Carlos López</code>");
    expect(capturedInput.replyMarkup.inline_keyboard[0][0].text).toBe("Ver en Panel");
  });

  it("enruta alertas de infraestructura al topic de infraestructura", async () => {
    let capturedInput: any = null;
    const fakeGateway: TelegramGatewayPort = {
      getMe: vi.fn(),
      sendMessage: vi.fn().mockImplementation(async (input) => {
        capturedInput = input;
        return { ok: true, messageId: 56, chatId: input.chatId, date: Date.now() };
      }),
    };

    const useCase = new SendTelegramAlertUseCase({
      gateway: fakeGateway,
      getSettings: async () => baseSettings,
      logger: silentLogger,
    });

    await useCase.execute({
      category: "INFRASTRUCTURE",
      severity: "WARNING",
      title: "Posible corte de fibra",
      body: "5 casos simultáneos en Sector Ricaurte OLT-01",
    });

    expect(capturedInput.messageThreadId).toBe(20); // infraTopicId
    expect(capturedInput.text).toContain("⚠️ <b>[ALERTA]</b> <b>Posible corte de fibra</b>");
  });
});
