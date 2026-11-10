import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TelegramGatewayHttp } from "../../src/core/modules/telegram/infrastructure/http/telegram-gateway.http";
import { silentLogger } from "../support/silent-logger";

describe("TelegramGatewayHttp", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("getMe retorna la identidad del bot si la respuesta es exitosa", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          id: 123456789,
          is_bot: true,
          first_name: "OpsBot",
          username: "isp_ops_bot",
        },
      }),
    });

    const gateway = new TelegramGatewayHttp({
      logger: silentLogger,
      defaultBotToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    });

    const info = await gateway.getMe();
    expect(info.id).toBe(123456789);
    expect(info.username).toBe("isp_ops_bot");
    expect(info.first_name).toBe("OpsBot");
  });

  it("getMe arroja error de negocio si Telegram responde 401 Unauthorized", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        ok: false,
        error_code: 401,
        description: "Unauthorized",
      }),
    });

    const gateway = new TelegramGatewayHttp({
      logger: silentLogger,
      defaultBotToken: "token-invalido",
    });

    await expect(gateway.getMe()).rejects.toThrow(/Error de autenticación con Telegram: Unauthorized/);
  });

  it("sendMessage despacha el mensaje con formato HTML y message_thread_id hacia el chat", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    global.fetch = vi.fn().mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init.body));
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            message_id: 999,
            chat: { id: -1001234567890 },
            date: 1700000000,
          },
        }),
      };
    });

    const gateway = new TelegramGatewayHttp({
      logger: silentLogger,
      defaultBotToken: "bot-token-123",
      defaultChatId: "-1001234567890",
    });

    const result = await gateway.sendMessage({
      text: "<b>Alerta de prueba</b>",
      messageThreadId: 42,
      replyMarkup: {
        inline_keyboard: [[{ text: "Ver en Panel", url: "https://isp.local/cases/1" }]],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(999);
    expect(capturedUrl).toContain("/botbot-token-123/sendMessage");
    expect(capturedBody).toMatchObject({
      chat_id: "-1001234567890",
      text: "<b>Alerta de prueba</b>",
      parse_mode: "HTML",
      message_thread_id: 42,
      reply_markup: {
        inline_keyboard: [[{ text: "Ver en Panel", url: "https://isp.local/cases/1" }]],
      },
    });
  });

  it("sendMessage falla si no se especifica chatId ni en el mensaje ni por defecto", async () => {
    const gateway = new TelegramGatewayHttp({
      logger: silentLogger,
      defaultBotToken: "token-valido",
    });

    await expect(
      gateway.sendMessage({ text: "hola" }),
    ).rejects.toThrow(/chatId de Telegram no especificado/);
  });
});
