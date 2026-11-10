import { describe, expect, it, vi } from "vitest";
import { TestTelegramConnectionUseCase } from "../../src/core/modules/telegram/application/use-cases/test-telegram-connection.use-case";
import type { TelegramGatewayPort } from "../../src/core/modules/telegram/application/ports/telegram-gateway.port";
import { silentLogger } from "../support/silent-logger";

describe("TestTelegramConnectionUseCase", () => {
  it("valida el bot con getMe y envía mensaje de prueba si se proporciona chatId", async () => {
    const sentMessages: any[] = [];
    const fakeGateway: TelegramGatewayPort = {
      getMe: vi.fn().mockResolvedValue({
        id: 777,
        is_bot: true,
        first_name: "ISPOpsBot",
        username: "isp_ops_bot",
      }),
      sendMessage: vi.fn().mockImplementation(async (input) => {
        sentMessages.push(input);
        return { ok: true, messageId: 101, chatId: input.chatId, date: Date.now() };
      }),
    };

    const useCase = new TestTelegramConnectionUseCase({
      gateway: fakeGateway,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      botToken: "sample-token",
      chatId: "-1009999",
      sendSampleMessage: true,
    });

    expect(result.ok).toBe(true);
    expect(result.bot.username).toBe("isp_ops_bot");
    expect(result.messageSent).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].chatId).toBe("-1009999");
    expect(sentMessages[0].text).toContain("Conexión exitosa con el sistema ISP");
  });

  it("valida el bot sin enviar mensaje si sendSampleMessage es false", async () => {
    const fakeGateway: TelegramGatewayPort = {
      getMe: vi.fn().mockResolvedValue({
        id: 777,
        is_bot: true,
        first_name: "ISPOpsBot",
        username: "isp_ops_bot",
      }),
      sendMessage: vi.fn(),
    };

    const useCase = new TestTelegramConnectionUseCase({
      gateway: fakeGateway,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      botToken: "sample-token",
      chatId: "-1009999",
      sendSampleMessage: false,
    });

    expect(result.ok).toBe(true);
    expect(result.messageSent).toBe(false);
    expect(fakeGateway.sendMessage).not.toHaveBeenCalled();
  });
});
