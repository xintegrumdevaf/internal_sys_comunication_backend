import type {
  AnswerCallbackQueryInput,
  SendTelegramMessageInput,
  SetWebhookInput,
  TelegramBotInfo,
  TelegramMessageResult,
} from "../../domain/telegram-message.types";

export interface TelegramGatewayPort {
  /**
   * Consulta la identidad del bot en Telegram (getMe) para validar credenciales.
   * @param token Token opcional; si no se provee, usa el configurado por defecto.
   */
  getMe(token?: string): Promise<TelegramBotInfo>;

  /**
   * Envía un mensaje con formato HTML/Markdown y botones interactivos opcionales.
   * @param input Parámetros del mensaje (texto, chat, topic, teclado).
   * @param token Token opcional para pruebas sin persistir.
   */
  sendMessage(input: SendTelegramMessageInput, token?: string): Promise<TelegramMessageResult>;

  /**
   * Responde a una pulsación de botón inline (callback_query) para quitar el spinner en la app de Telegram.
   */
  answerCallbackQuery(input: AnswerCallbackQueryInput, token?: string): Promise<boolean>;

  /**
   * Registra o actualiza la URL del webhook en api.telegram.org.
   */
  setWebhook(input: SetWebhookInput, token?: string): Promise<boolean>;
}

