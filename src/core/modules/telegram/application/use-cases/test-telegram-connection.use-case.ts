import type { Logger } from "../../../../../shared/logging/logger";
import type { TelegramGatewayPort } from "../ports/telegram-gateway.port";
import type { TelegramBotInfo } from "../../domain/telegram-message.types";

export interface TestTelegramConnectionInput {
  botToken?: string;
  chatId?: string;
  messageThreadId?: number | null;
  sendSampleMessage?: boolean;
}

export interface TestTelegramConnectionResult {
  ok: boolean;
  latencyMs: number;
  bot: TelegramBotInfo;
  messageSent: boolean;
  message: string;
}

export class TestTelegramConnectionUseCase {
  constructor(
    private readonly deps: {
      gateway: TelegramGatewayPort;
      logger: Logger;
    },
  ) {}

  async execute(input: TestTelegramConnectionInput = {}): Promise<TestTelegramConnectionResult> {
    const started = Date.now();
    const bot = await this.deps.gateway.getMe(input.botToken);
    const latencyMs = Date.now() - started;

    let messageSent = false;
    const shouldSend = input.sendSampleMessage ?? Boolean(input.chatId);

    if (shouldSend && input.chatId) {
      const nowFormatted = new Date().toLocaleString("es-EC", { timeZone: "America/Guayaquil" });
      const sampleText = [
        "<b>🟢 Conexión exitosa con el sistema ISP</b>",
        "",
        `🤖 <b>Bot:</b> @${bot.username || bot.first_name} (ID: <code>${bot.id}</code>)`,
        "📡 <b>Canal:</b> Alertas y Pulso Operativo Directivo",
        `🕒 <b>Hora del servidor:</b> ${nowFormatted}`,
        "",
        "<i>Este es un mensaje de prueba emitido desde el panel de control para verificar credenciales y permisos en este grupo.</i>",
      ].join("\n");

      await this.deps.gateway.sendMessage(
        {
          chatId: input.chatId,
          messageThreadId: input.messageThreadId,
          text: sampleText,
          parseMode: "HTML",
        },
        input.botToken,
      );

      messageSent = true;
    }

    this.deps.logger.info(
      { botUsername: bot.username, latencyMs, messageSent },
      "prueba de conexión con Telegram completada satisfactoriamente",
    );

    return {
      ok: true,
      latencyMs,
      bot,
      messageSent,
      message: messageSent
        ? `Bot @${bot.username || bot.first_name} verificado y mensaje de prueba enviado correctamente (${latencyMs}ms).`
        : `Bot @${bot.username || bot.first_name} verificado exitosamente (${latencyMs}ms).`,
    };
  }
}

