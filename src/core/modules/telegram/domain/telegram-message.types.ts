/**
 * Botones interactivos en línea de Telegram (Inline Keyboard).
 */
export type TelegramInlineButton = {
  text: string;
  url?: string;
  callback_data?: string;
};

export type TelegramInlineKeyboard = {
  inline_keyboard: TelegramInlineButton[][];
};

/**
 * Severidad de las alertas operativas.
 */
export type TelegramAlertSeverity = "INFO" | "WARNING" | "CRITICAL";

/**
 * Categorías de alertas que pueden enrutarse a topics separados.
 */
export type TelegramAlertCategory = "SLA" | "INFRASTRUCTURE" | "QUEUE" | "QUALITY" | "DIGEST" | "SYSTEM";

/**
 * Parámetros para emitir un mensaje o alerta a Telegram.
 */
export interface SendTelegramMessageInput {
  chatId?: string;
  messageThreadId?: number | null;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  replyMarkup?: TelegramInlineKeyboard;
  disableNotification?: boolean;
}

/**
 * Estructura de alerta enriquecida para el despachador.
 */
export interface TelegramAlertPayload {
  category: TelegramAlertCategory;
  severity: TelegramAlertSeverity;
  title: string;
  body: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  actions?: Array<{ label: string; url?: string; callbackData?: string }>;
  forced?: boolean;
  chatId?: string;
  botToken?: string;
  messageThreadId?: number | null;
}

/**
 * Respuesta genérica de la API oficial de Telegram.
 */
export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/**
 * Información básica del bot obtenida mediante getMe.
 */
export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

/**
 * Resultado de envío de mensaje.
 */
export interface TelegramMessageResult {
  ok: boolean;
  messageId: number;
  chatId: string | number;
  date: number;
}

/**
 * Estructuras de Webhook entrante de Telegram (Updates).
 */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number | string;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  message_thread_id?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface AnswerCallbackQueryInput {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}

export interface SetWebhookInput {
  url: string;
  secretToken?: string;
  dropPendingUpdates?: boolean;
}

