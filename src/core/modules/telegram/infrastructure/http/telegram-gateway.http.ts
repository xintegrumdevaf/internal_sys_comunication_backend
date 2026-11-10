import { businessError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { TelegramGatewayPort } from "../../application/ports/telegram-gateway.port";
import type {
  SendTelegramMessageInput,
  TelegramApiResponse,
  TelegramBotInfo,
  TelegramMessageResult,
} from "../../domain/telegram-message.types";

export interface TelegramGatewayHttpDeps {
  logger: Logger;
  defaultBotToken?: string;
  defaultChatId?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class TelegramGatewayHttp implements TelegramGatewayPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly deps: TelegramGatewayHttpDeps) {
    this.baseUrl = deps.baseUrl ?? "https://api.telegram.org";
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  private resolveToken(explicitToken?: string): string {
    const token = (explicitToken ?? this.deps.defaultBotToken ?? "").trim();
    if (!token) {
      throw businessError("Telegram botToken no está configurado ni provisto");
    }
    return token;
  }

  async getMe(token?: string): Promise<TelegramBotInfo> {
    const effectiveToken = this.resolveToken(token);
    const url = `${this.baseUrl}/bot${effectiveToken}/getMe`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const body = (await response.json()) as TelegramApiResponse<TelegramBotInfo>;

      if (!response.ok || !body.ok || !body.result) {
        const errorMsg = body.description || `HTTP ${response.status} en getMe`;
        this.deps.logger.warn({ status: response.status, description: body.description }, "error al consultar getMe en Telegram");
        throw businessError(`Error de autenticación con Telegram: ${errorMsg}`);
      }

      return body.result;
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw businessError("Tiempo de espera agotado al conectar con Telegram API (Timeout)");
      }
      if (err instanceof Error && err.message.includes("Telegram")) {
        throw err;
      }
      this.deps.logger.error({ err }, "fallo de red o conexión al contactar Telegram");
      throw businessError(`No se pudo conectar con el servidor de Telegram: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async sendMessage(input: SendTelegramMessageInput, token?: string): Promise<TelegramMessageResult> {
    const effectiveToken = this.resolveToken(token);
    const chatId = (input.chatId ?? this.deps.defaultChatId ?? "").trim();
    if (!chatId) {
      throw businessError("chatId de Telegram no especificado en el mensaje ni en la configuración general");
    }

    if (!input.text || input.text.trim() === "") {
      throw businessError("El texto del mensaje de Telegram no puede estar vacío");
    }

    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: input.text,
      parse_mode: input.parseMode ?? "HTML",
      disable_notification: Boolean(input.disableNotification),
    };

    if (input.messageThreadId) {
      payload.message_thread_id = input.messageThreadId;
    }

    if (input.replyMarkup && input.replyMarkup.inline_keyboard.length > 0) {
      payload.reply_markup = input.replyMarkup;
    }

    const url = `${this.baseUrl}/bot${effectiveToken}/sendMessage`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const body = (await response.json()) as TelegramApiResponse<{
        message_id: number;
        chat: { id: number | string };
        date: number;
      }>;

      if (!response.ok || !body.ok || !body.result) {
        const desc = body.description || `HTTP ${response.status}`;
        this.deps.logger.warn({ status: response.status, description: desc, chatId }, "Telegram sendMessage rechazado");
        throw businessError(`Telegram rechazó el envío del mensaje: ${desc}`);
      }

      return {
        ok: true,
        messageId: body.result.message_id,
        chatId: body.result.chat.id,
        date: body.result.date,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw businessError("Timeout al enviar mensaje a Telegram");
      }
      if (err instanceof Error && err.message.includes("Telegram")) {
        throw err;
      }
      this.deps.logger.error({ err, chatId }, "error al invocar sendMessage en Telegram API");
      throw businessError(`Fallo al enviar mensaje a Telegram: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

