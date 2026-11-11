import { businessError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { TelegramGatewayPort } from "../../application/ports/telegram-gateway.port";
import type {
  AnswerCallbackQueryInput,
  SendTelegramMessageInput,
  SetWebhookInput,
  TelegramApiResponse,
  TelegramBotInfo,
  TelegramMessageResult,
} from "../../domain/telegram-message.types";

export interface TelegramGatewayHttpDeps {
  logger: Logger;
  defaultBotToken?: string;
  defaultChatId?: string;
  getToken?: () => Promise<string | undefined> | string | undefined;
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

  private async resolveToken(explicitToken?: string): Promise<string> {
    const isMasked =
      typeof explicitToken === "string" &&
      (explicitToken.includes("•") || explicitToken.includes("*"));
    if (!isMasked && explicitToken && explicitToken.trim() !== "") {
      return explicitToken.trim();
    }
    if (this.deps.getToken) {
      try {
        const dynamicToken = await this.deps.getToken();
        if (dynamicToken && !dynamicToken.includes("•") && dynamicToken.trim() !== "") {
          return dynamicToken.trim();
        }
      } catch {
        // fallback
      }
    }
    const token = (this.deps.defaultBotToken ?? "").trim();
    if (!token) {
      throw businessError("Telegram botToken no está configurado ni provisto");
    }
    return token;
  }

  async getMe(token?: string): Promise<TelegramBotInfo> {
    const effectiveToken = await this.resolveToken(token);
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
    const effectiveToken = await this.resolveToken(token);
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

      if (body.parameters?.migrate_to_chat_id) {
        const newChatId = String(body.parameters.migrate_to_chat_id);
        this.deps.logger.info(
          { oldChatId: chatId, newChatId },
          "Telegram group chat was upgraded to supergroup; reintentando automáticamente con migrate_to_chat_id",
        );
        const retryResult = await this.sendMessage(
          {
            ...input,
            chatId: newChatId,
          },
          effectiveToken,
        );
        return {
          ...retryResult,
          migratedToChatId: newChatId,
        };
      }

      if (!response.ok || !body.ok || !body.result) {
        const desc = body.description || `HTTP ${response.status}`;
        this.deps.logger.warn({ status: response.status, description: desc, chatId }, "Telegram sendMessage rechazado");

        if (desc.toLowerCase().includes("group chat was upgraded to a supergroup")) {
          throw businessError(
            "Telegram convirtió tu grupo en un Supergrupo (al activar temas o historial) y cambió su ID. Hacé clic en 'Detectar Grupo' o anteponé -100 al Chat ID actual para actualizarlo.",
          );
        }

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

  async answerCallbackQuery(input: AnswerCallbackQueryInput, token?: string): Promise<boolean> {
    const effectiveToken = await this.resolveToken(token);
    const url = `${this.baseUrl}/bot${effectiveToken}/answerCallbackQuery`;

    const payload: Record<string, unknown> = {
      callback_query_id: input.callbackQueryId,
    };
    if (input.text) payload.text = input.text;
    if (input.showAlert) payload.show_alert = true;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const body = (await response.json()) as TelegramApiResponse<boolean>;
      if (!response.ok || !body.ok) {
        this.deps.logger.warn({ status: response.status, description: body.description }, "error en answerCallbackQuery");
        return false;
      }
      return true;
    } catch (err) {
      this.deps.logger.warn({ err, callbackQueryId: input.callbackQueryId }, "fallo de red en answerCallbackQuery");
      return false;
    }
  }

  async setWebhook(input: SetWebhookInput, token?: string): Promise<boolean> {
    const effectiveToken = await this.resolveToken(token);
    const url = `${this.baseUrl}/bot${effectiveToken}/setWebhook`;

    const payload: Record<string, unknown> = {
      url: input.url,
      drop_pending_updates: Boolean(input.dropPendingUpdates),
    };
    if (input.secretToken) {
      payload.secret_token = input.secretToken;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const body = (await response.json()) as TelegramApiResponse<boolean>;
      if (!response.ok || !body.ok) {
        const desc = body.description || `HTTP ${response.status}`;
        this.deps.logger.warn({ status: response.status, description: desc }, "error en setWebhook de Telegram");
        throw businessError(`Error al configurar webhook de Telegram: ${desc}`);
      }
      return true;
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw businessError("Timeout al registrar webhook en Telegram");
      }
      if (err instanceof Error && err.message.includes("Telegram")) {
        throw err;
      }
      this.deps.logger.error({ err }, "error al invocar setWebhook en Telegram API");
      throw businessError(`Fallo al registrar webhook en Telegram: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getRecentChats(token?: string): Promise<Array<{ id: string; title: string; type: string }>> {
    const effectiveToken = await this.resolveToken(token);
    const url = `${this.baseUrl}/bot${effectiveToken}/getUpdates?limit=50`;

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const body = (await response.json()) as {
        ok: boolean;
        result?: Array<{
          message?: {
            chat?: { id: number; title?: string; type: string; first_name?: string };
            migrate_to_chat_id?: number;
          };
          my_chat_member?: { chat?: { id: number; title?: string; type: string } };
          channel_post?: { chat?: { id: number; title?: string; type: string } };
        }>;
      };

      if (!response.ok || !body.ok || !Array.isArray(body.result)) {
        return [];
      }

      const chatsMap = new Map<string, { id: string; title: string; type: string }>();
      for (const update of body.result) {
        if (update.message?.migrate_to_chat_id) {
          const targetId = String(update.message.migrate_to_chat_id);
          chatsMap.set(targetId, {
            id: targetId,
            title: update.message.chat?.title || "Supergrupo Directivo",
            type: "supergroup",
          });
        }

        const chat = update.message?.chat || update.my_chat_member?.chat || update.channel_post?.chat;
        if (chat && (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel")) {
          chatsMap.set(String(chat.id), {
            id: String(chat.id),
            title: chat.title || "Grupo de Telegram",
            type: chat.type,
          });
        }
      }

      const list = Array.from(chatsMap.values());
      list.sort((a, b) => {
        if (a.type === "supergroup" && b.type !== "supergroup") return -1;
        if (b.type === "supergroup" && a.type !== "supergroup") return 1;
        return 0;
      });
      return list;
    } catch (err) {
      this.deps.logger.warn({ err }, "error al consultar getUpdates para detección de chats");
      return [];
    }
  }
}

